import test from 'node:test';
import assert from 'node:assert/strict';
import { STUDIO_ID, STUDIO_VERBS, enrichedPrompt, enrichMessages } from '../lib/studio.mjs';
import { ToolRuntime, checkStyles } from '../lib/tool-runtime.mjs';
import { comfyGraph } from '../lib/comfy-graphs.mjs';
import { comfyNames } from '../lib/comfy-engine.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../server.mjs';

/** The project each file dropped in the Studio was kept in (« #ref3 » of that project). */
const importedInto = [];

test('a prompt is enriched from what the user typed, for the creation it is for', () => {
  const [system, user] = enrichMessages('  un renard dans la neige  ');
  // What was typed is the whole request; the model is told to keep it and add what is missing.
  assert.equal(user.content, 'un renard dans la neige');
  assert.match(system.content, /the prompt of an image/);
  assert.match(system.content, /Keep everything the user asked for/);
  assert.match(system.content, /Answer with the prompt alone/);
  // The same guidance as when the chat model writes a prompt itself, per kind of creation.
  assert.match(system.content, /three to six sentences in English/);
  const [video] = enrichMessages('un renard', { verb: 'create_video' });
  assert.match(video.content, /the prompt of a video clip/);
  assert.match(video.content, /present tense/);
  assert.match(enrichMessages('la suite', { verb: 'extend_video' })[0].content, /continuation of a video clip/);
  // An unknown verb is an image; the user's standing instructions come last and win.
  assert.match(enrichMessages('x', { verb: 'nope' })[0].content, /the prompt of an image/);
  assert.doesNotMatch(system.content, /standing instructions/);
  const [wished] = enrichMessages('un renard', { preferences: ' 500 caractères, en anglais ' });
  assert.match(
    wished.content,
    /standing instructions, which come first where they differ: 500 caractères, en anglais$/,
  );
});

test('the answer is kept as the prompt alone', () => {
  assert.equal(
    enrichedPrompt('<think>hmm</think>\n"Prompt: A red fox sits in fresh snow.\n\nSoft morning light."\n'),
    'A red fox sits in fresh snow.\nSoft morning light.',
  );
  assert.equal(enrichedPrompt('Enriched prompt: « A fox »'), 'A fox');
  assert.equal(enrichedPrompt('x'.repeat(5000)).length, 4000);
  assert.equal(enrichedPrompt(null), '');
});

test('the Studio has its own identifier and the verbs it may start', () => {
  assert.match(STUDIO_ID, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  for (const verb of ['create_image', 'create_video', 'extend_video', 'create_audio'])
    assert.ok(STUDIO_VERBS.includes(verb));
});

test('style LoRAs: three at most, a name and a strength within limits', () => {
  assert.deepEqual(checkStyles([{ name: 'a.safetensors' }, { name: 'sub\\b.safetensors', strength: 0.5 }]), [
    { name: 'a.safetensors', strength: 1 },
    { name: 'sub\\b.safetensors', strength: 0.5 },
  ]);
  assert.throws(() => checkStyles([{ name: '' }]), /Style invalide/);
  assert.throws(() => checkStyles([{ name: 'a', strength: 9 }]), /Style invalide/);
  assert.equal(checkStyles(Array(3).fill({ name: 'a' })).length, 3);
  assert.throws(() => checkStyles(Array(4).fill({ name: 'a' })), /trois/);
});

const krea = styles => ({
  id: '00000000-0000-4000-8000-000000000000',
  pipeline: 'krea2',
  mediaType: 'image',
  references: [],
  loras: [],
  styles,
  parameters: { prompt: 'un renard', seed: 1, width: 1024, height: 1024, steps: 8, attention: 'comfy_kitchen' },
  components: { model: 'm/krea.safetensors', textEncoder: 'm/qwen.safetensors', vae: 'm/vae.safetensors' },
});

test('the styles of a Studio job are LoRA nodes between the model and the sampler, under ComfyUI’s names', async () => {
  const styles = [
    { name: '70sSCiFiKrea2Raw.safetensors', strength: 0.55 },
    { name: 'krea2_detail_slider.safetensors', strength: 0.2 },
  ];
  const { graph } = comfyGraph(krea(styles));
  assert.deepEqual(graph.style0.inputs, { lora_name: styles[0].name, strength_model: 0.55, model: ['model', 0] });
  assert.deepEqual(graph.style1.inputs.model, ['style0', 0]);
  assert.deepEqual(graph.attention.inputs.model, ['style1', 0]);
  assert.deepEqual(graph.sampler.inputs.model, ['attention', 0]);
  assert.equal(comfyGraph(krea(undefined)).graph.style0, undefined);

  const lists = {
    UNETLoader: ['unet_name', ['krea.safetensors']],
    CLIPLoader: ['clip_name', ['qwen.safetensors']],
    VAELoader: ['vae_name', ['vae.safetensors']],
    LoraLoaderModelOnly: ['lora_name', ['styles\\70sSCiFiKrea2Raw.safetensors', 'krea2_detail_slider.safetensors']],
  };
  const client = {
    objectInfo: async ({ node }) => ({
      [node]: { input: { required: lists[node] ? { [lists[node][0]]: [lists[node][1], {}] } : {} } },
    }),
  };
  const names = await comfyNames(client, krea(styles));
  assert.equal(names.style0, 'styles\\70sSCiFiKrea2Raw.safetensors');
  assert.equal(names.style1, 'krea2_detail_slider.safetensors');
  await assert.rejects(comfyNames(client, krea([{ name: 'absent.safetensors', strength: 1 }])), /absent\.safetensors/);
});

test('a model this computer cannot run is shown greyed with its reason, others not ready stay out', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const { ToolCatalog } = await import('../lib/tool-catalog.mjs');
  const folder = new URL('../runner/workflows/', import.meta.url);
  const reason = 'Krea2 demande une carte graphique NVIDIA : son pilote n’en voit aucune sur cet ordinateur.';
  const workflows = [];
  for (const name of await readdir(folder)) {
    const workflow = JSON.parse(await readFile(new URL(name, folder), 'utf8'));
    // No NVIDIA card: the image and video models of the built-in engine cannot compute; a
    // workflow whose file is missing is another matter, and the sounds still run.
    if (workflow.pipeline === 'krea2')
      workflows.push({ ...workflow, ready: false, unavailableReason: reason, unavailableKind: 'hardware' });
    else if (workflow.pipeline === 'minimax_h3')
      workflows.push({ ...workflow, ready: false, unavailableReason: 'Fichier introuvable pour « Modèle ».' });
    else workflows.push({ ...workflow, ready: true });
  }
  const catalog = new ToolCatalog({ list: async () => workflows });
  const tools = await catalog.studio();
  const images = tools.create_image.map(item => [item.family, item.unavailable]);
  // The ready model first (it is the one in hand), the greyed one after it with its reason.
  assert.deepEqual(images, [
    ['moss', undefined],
    ['krea2', reason],
  ]);
  assert.ok(tools.create_image[1].limits, 'described as the others, for the page to draw it');
  // Not ready for another reason: left out, as before.
  assert.deepEqual(
    tools.create_video.map(item => item.family),
    ['ltx25'],
  );
  // The chat model is not offered what cannot run, and a request for it finds no workflow.
  const offered = (await catalog.definitions()).find(tool => tool.function.name === 'create_image');
  assert.doesNotMatch(offered.function.description, /Krea 2/);
});

test('the Studio is told, per verb, the ready workflows with their inputs, sizes, lengths and settings', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const { ToolCatalog } = await import('../lib/tool-catalog.mjs');
  const folder = new URL('../runner/workflows/', import.meta.url);
  const workflows = [];
  for (const name of await readdir(folder))
    workflows.push({ ...JSON.parse(await readFile(new URL(name, folder), 'utf8')), ready: true });
  const tools = await new ToolCatalog({ list: async () => workflows }).studio();
  const named = (verb, name) => tools[verb].find(item => item.name.startsWith(name));

  const krea = named('create_image', 'Krea 2');
  assert.deepEqual(krea.size, { width: 1024, height: 1024 });
  // Each model with its family: the page keeps a family's LoRAs to itself.
  assert.equal(krea.family, 'krea2');
  assert.equal(named('create_image', 'MOSS').family, 'moss');
  assert.equal(krea.limits.width.max, 4096);
  assert.equal(krea.roles.source.count, 1);
  // The name each input has in the record of a take, and the case of the Studio it goes back to.
  assert.ok(Object.values(krea.inputs).includes('source'));
  for (const tool of Object.values(tools).flat())
    for (const role of Object.values(tool.inputs)) assert.ok(tool.roles[role]?.count > 0, tool.name + ' · ' + role);

  const h3 = named('create_video', 'MiniMax');
  assert.deepEqual(h3.size, { width: 768, height: 448 });
  assert.deepEqual(h3.final, { width: 1344, height: 768 });
  // No start or end image: its model (Omni-Ref) does not follow them; references only.
  assert.deepEqual([h3.roles.start_image.count, h3.roles.end_image.count, h3.roles.reference.count], [0, 0, 3]);
  const ltxFrames = named('create_video', 'LTX');
  assert.deepEqual([ltxFrames.roles.start_image.count, ltxFrames.roles.end_image.count], [1, 1]);
  assert.ok(Math.abs(h3.lengths.seconds[0] - 124 / 24) < 1e-9);
  assert.ok(h3.exclusive);

  const ltx = named('create_video', 'LTX');
  assert.ok(ltx.lengths.seconds.includes(5) || ltx.lengths.seconds.some(s => Math.abs(s - 121 / 24) < 1e-9));
  const more = named('extend_video', 'MiniMax');
  assert.equal(more.roles.source.count, 1);
  // 141 frames with 22 taken from the source: 119 new ones.
  assert.ok(more.lengths.seconds.some(s => Math.abs(s - 119 / 24) < 1e-9));

  const music = named('create_audio', 'Musique');
  assert.deepEqual(music.settings.map(item => item.key).sort(), ['language', 'lyrics', 'seconds']);
  assert.match(music.for, /music/);
  assert.equal(named('create_audio', 'Bruitages').settings.find(item => item.key === 'seconds').max, 30);

  // A character put in a video: a verb of its own, a video and an image both needed, who is who
  // in two settings; no size nor length, which are the video's.
  const [scail] = tools.replace_character;
  assert.equal(scail.family, 'wan_scail2');
  assert.deepEqual([scail.verb, scail.follows], ['replace_character', true]);
  assert.deepEqual(scail.roles, {
    source: { count: 1, media: ['video'], many: false, required: true },
    reference: { count: 1, media: ['image'], many: false, required: true },
  });
  assert.deepEqual(
    scail.settings.map(item => [item.key, item.default]),
    [
      ['subject', 'person'],
      ['reference_subject', 'person'],
    ],
  );
  assert.deepEqual([scail.limits, scail.size, scail.lengths], [undefined, undefined, undefined]);
  // The other verbs say theirs, and are not told to follow a video.
  assert.deepEqual([h3.verb, h3.follows, more.verb, more.follows], ['create_video', undefined, 'extend_video', undefined]);
  assert.equal(h3.roles.reference.many, true);
});

test('a character replaced in a video: its model among the videos, a video and an image handed over, who is who', async () => {
  const clip = {
      id: 'v',
      name: 'Clip',
      verb: 'create_video',
      limits: sizes,
      size: { width: 768, height: 448 },
      settings: [],
      seeded: true,
      roles: { start_image: { count: 1, media: ['image'], many: false } },
    },
    scail = {
      id: 's',
      name: 'SCAIL-2',
      verb: 'replace_character',
      follows: true,
      seeded: true,
      roles: {
        source: { count: 1, media: ['video'], many: false, required: true },
        reference: { count: 1, media: ['image'], many: false, required: true },
      },
      settings: [
        { key: 'subject', type: 'string', maxLength: 200, default: 'person' },
        { key: 'reference_subject', type: 'string', maxLength: 200, default: 'person' },
      ],
    };
  const page = await studioPage(
    { create_video: [clip], replace_character: [scail] },
    {
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }),
      'studio/enrich': () => ({ prompt: 'A woman in a white top wipes an apple in an orchard.', seen: true }),
    },
  );
  const { body, asked, notices, restore } = page;
  try {
    page.mode(1);
    const wand = () => body.find('studio-enrich-go')[0],
      enriched = () => asked.filter(([route]) => route === 'studio/enrich');
    const blocks = () => body.find('studio-input-block').map(block => block.attributes['aria-label']),
      slots = () => body.find('studio-slot'),
      event = files => ({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files, setData() {} } }),
      drop = async (index, file) => {
        slots()[index].ondrop(event([file]));
        await new Promise(resolve => setTimeout(resolve, 5));
      },
      generate = async () => {
        await body.find('studio-go')[0].onclick();
        await settle();
      },
      sent = () => asked.filter(([route]) => route === 'tools/action');
    // Both models in the one list of the videos; the first is the one that makes a clip.
    const pick = body.find('studio-model-pick')[0];
    assert.equal(pick.children.length, 2);
    assert.deepEqual(blocks(), ['Image de début']);
    pick.value = 's';
    pick.onchange();
    // Its inputs: the video, the character, and who is who. No rare setting but the seed.
    assert.deepEqual(blocks(), ['Vidéo à suivre et personnage', 'Qui est qui']);
    assert.deepEqual(
      body.find('studio-slot-pick').map(pick => pick.attributes['aria-label']),
      ['Ajouter la vidéo à suivre', 'Ajouter l’image du personnage'],
    );
    assert.equal(page.prompt().placeholder, 'Décrivez la vidéo avec votre personnage…');
    const who = () => body.find('studio-who')[0].children;
    assert.deepEqual(
      who().map(field => [field.children[0].textContent, field.children[1].value, field.children[1].placeholder]),
      [
        ['Qui remplacer', 'person', 'girl, handkerchief'],
        ['Qui dessiner', 'person', 'woman'],
      ],
    );
    // Each says what it is for in its « ? », as the settings do: at once under the pointer.
    const tips = who().map(field => field.children[0].children.find(child => /help-tip/.test(child.className)));
    assert.deepEqual(
      tips.map(tip => [tip.textContent, tip.tabIndex, tip.attributes.role]),
      [
        ['?', 0, 'img'],
        ['?', 0, 'img'],
      ],
    );
    assert.match(tips[0].dataset.help, /« penguin ».*\n.*« girl, handkerchief »/s);
    assert.match(tips[1].dataset.help, /décor de l’image est laissé de côté/);
    assert.equal(tips[0].attributes['aria-label'], 'Aide : ' + tips[0].dataset.help);
    assert.equal(body.find('studio-rare')[0].children.length, 1);
    // The wand writes the prompt from the video and the character: it waits for both, not for words.
    assert.equal(wand().disabled, true);
    assert.equal(wand().title, 'Ajoutez d’abord la vidéo et le personnage');
    await wand().onclick();
    assert.equal(enriched().length, 0);
    // What the model cannot do without is asked for in plain words, nothing is sent.
    page.prompt().value = 'Une femme en haut blanc mange une pomme dans un verger.';
    page.prompt().oninput();
    await generate();
    assert.match(body.find('studio-error')[0].textContent, /Ajoutez la vidéo à suivre/);
    assert.equal(sent().length, 0);
    // An image is not a video: the slot says so and stays empty.
    await drop(0, { name: 'photo.png', type: 'image/png' });
    assert.match(notices.at(-1), /attend une vidéo/);
    await drop(0, { name: 'clip.mp4', type: 'video/mp4' });
    assert.match(slots()[0].className, /is-filled/);
    // Kept as a reference of the project of the conversation (Conversations here).
    assert.equal(importedInto.at(-1), 'inbox');
    await generate();
    assert.match(body.find('studio-error')[0].textContent, /Ajoutez l’image du personnage/);
    await drop(1, { name: 'clip.mp4', type: 'video/mp4' });
    assert.match(notices.at(-1), /attend une image/);
    await drop(1, { name: 'perso.png', type: 'image/png' });
    // Both given: the wand is ready, even with nothing typed, and hands the two over.
    page.prompt().value = '';
    page.prompt().oninput();
    assert.equal(wand().disabled, false);
    // Drawn again (another model and back), the wand is still ready: the page itself says so.
    page.studio.render();
    assert.equal(wand().disabled, false);
    assert.match(wand().title, /^Écrire le prompt d’après la vidéo et le personnage/);
    await generate();
    assert.match(body.find('studio-error')[0].textContent, /cliquez sur la baguette/);
    await wand().onclick();
    await settle();
    assert.deepEqual(enriched().at(-1)[1], {
      prompt: '',
      verb: 'replace_character',
      source: { resource: 'r1' },
      reference: { resource: 'r2' },
      // A video or a character made in the conversation is found there.
      conversationId: 'c1',
    });
    assert.equal(page.prompt().value, 'A woman in a white top wipes an apple in an orchard.');
    const subject = who()[0].children[1];
    subject.value = 'girl, handkerchief';
    subject.oninput();
    await generate();
    const [, action] = sent().at(-1);
    assert.equal(action.name, 'replace_character');
    // The video and the character each alone (not a list); who is drawn is left to its default.
    assert.deepEqual(action.arguments, {
      prompt: 'A woman in a white top wipes an apple in an orchard.',
      intention: 'Personnage remplacé, demandé dans le Studio.',
      source: { resource: 'r1' },
      reference: { resource: 'r2' },
      subject: 'girl, handkerchief',
    });
    // Back to the model of the clips: its own inputs, and its own verb.
    body.find('studio-model-pick')[0].value = 'v';
    body.find('studio-model-pick')[0].onchange();
    assert.deepEqual(blocks(), ['Image de début']);
    await generate();
    assert.equal(sent().at(-1)[1].name, 'create_video');
  } finally {
    restore();
  }
});

test('the page module loads and offers the sizes of a format', async () => {
  const { sizeChoices } = await import('../public/studio.mjs');
  const limits = { width: { min: 256, max: 2048, multipleOf: 32 }, height: { min: 256, max: 2048, multipleOf: 32 } };
  const { sizes, nearest } = sizeChoices({ limits }, '16:9', 768 * 448);
  assert.ok(sizes.length > 2);
  assert.ok(sizes.every(size => size.width > size.height && size.width % 32 === 0 && size.height % 32 === 0));
  assert.ok(Math.abs(nearest.width * nearest.height - 768 * 448) < 768 * 448 * 0.4);
});

test('the format frame keeps the ratio and fits its box, wide or tall', async () => {
  const { frameSize } = await import('../public/studio.mjs');
  const box = { width: 264, height: 176 };
  assert.deepEqual(frameSize(16 / 9, box), { width: 264, height: 149 });
  assert.deepEqual(frameSize(9 / 16, box), { width: 99, height: 176 });
  assert.deepEqual(frameSize(1, box), { width: 176, height: 176 });
  for (const ratio of [16 / 9, 4 / 3, 3 / 2, 1, 2 / 3, 3 / 4, 9 / 16]) {
    const size = frameSize(ratio, box);
    assert.ok(size.width <= box.width && size.height <= box.height);
    assert.ok(Math.abs(size.width / size.height / ratio - 1) < 0.02);
  }
});

test('« Enregistrer » keeps the settings of a model in a file of its own, and gives them with the tools of the Studio', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-preset-'));
  const app = await createApplication({ port: 0, dataDir: directory });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { readdir } = await import('node:fs/promises');
  const before = await readdir(directory);
  const { token } = await (await fetch(app.url + '/api/bootstrap?brief=1')).json();
  const api = (route, body) =>
    fetch(app.url + '/api/' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const preset = {
    length: 193 / 24,
    format: '16:9',
    size: '768x448',
    seed: '42',
    styles: [{ name: 'grain.safetensors', strength: 0.8 }],
    loras: { msr: { on: true, strength: 1.2 } },
  };
  const saved = await api('studio/preset', { workflow: 'h3', preset });
  assert.equal(saved.status, 200);
  const kept = (await saved.json()).preset;
  assert.equal(kept.seed, '42');
  assert.ok(kept.savedAt);
  // Given with the tools of the Studio, as kept.
  const studio = await (await api('studio')).json();
  assert.deepEqual(studio.presets.h3.loras, { msr: { on: true, strength: 1.2 } });
  assert.equal(studio.presets.h3.size, '768x448');
  // What is not a setting of the Studio is left out; what is wrong is refused, nothing kept.
  const other = await (
    await api('studio/preset', { workflow: 'ltx', preset: { length: 5, prompt: 'non', steps: 99 } })
  ).json();
  assert.deepEqual(Object.keys(other.preset).sort(), ['length', 'savedAt']);
  assert.equal((await api('studio/preset', { workflow: 'h3', preset: { seed: 'abc' } })).status, 400);
  assert.equal((await api('studio/preset', { workflow: '../x', preset: {} })).status, 400);
  assert.equal((await api('studio/preset', { workflow: 'h3', preset: { size: '768x448' } })).status, 400);
  assert.equal((await (await api('studio')).json()).presets.h3.seed, '42');
  // A file of its own, beside the others (the workflows are not written): both models in it.
  assert.ok(!before.includes('studio-presets.json'));
  const { readFile } = await import('node:fs/promises');
  const file = JSON.parse(await readFile(join(directory, 'studio-presets.json'), 'utf8'));
  assert.deepEqual(Object.keys(file.models).sort(), ['h3', 'ltx']);
});

test('a style the model does not write in time is said as such, and the model is free again', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-style-'));
  const app = await createApplication({
    port: 0,
    dataDir: directory,
    enrichTimeoutMs: 400,
    spawnProcess: (_command, args, options) =>
      spawn(
        process.execPath,
        [fileURLToPath(new URL('./fixtures/fake-engine.mjs', import.meta.url)), ...args],
        options,
      ),
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { token } = await (await fetch(app.url + '/api/bootstrap?brief=1')).json();
  const api = (route, body) =>
    fetch(app.url + '/api/' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const modelPath = join(directory, 'model.gguf');
  await writeFile(modelPath, Buffer.from('GGUF\x03\0\0\0'));
  await api('config', {
    enginePath: process.execPath,
    modelPath,
    projectorPath: '',
    contextSize: 4096,
    maxOutputTokens: 1024,
    gpuLayers: 0,
  });
  assert.equal((await api('start', {})).status, 202);
  for (let tries = 0; tries < 200 && (await (await api('status')).json()).state !== 'ready'; tries++)
    await new Promise(resolve => setTimeout(resolve, 25));
  // The simulated engine never finishes this one, like a model crawling on a shared graphics card.
  // Nothing to enrich is said at once, without asking the model.
  assert.equal((await api('studio/enrich', { prompt: '   ' })).status, 400);
  // A character put in a video: nothing typed is fine, the prompt comes from the two pictures.
  // (This simulated model does not see pictures: said as such, not as « write a few words ».)
  const blind = await api('studio/enrich', {
    prompt: '',
    verb: 'replace_character',
    source: { resource: '11111111-1111-4111-8111-111111111111' },
    reference: { resource: '22222222-2222-4222-8222-222222222222' },
  });
  assert.equal(blind.status, 502);
  assert.match((await blind.json()).error, /ne voit pas les images/);
  assert.equal((await api('studio/enrich', { prompt: '', verb: 'replace_character' })).status, 400);
  const late = await api('studio/enrich', { prompt: 'aquarelle, sans réponse', verb: 'create_image' });
  assert.equal(late.status, 504);
  assert.match((await late.json()).error, /n’a pas répondu en 0 secondes.*carte graphique/);
  const status = await (await api('status')).json();
  assert.deepEqual([status.state, status.busy], ['ready', false]);
});

test('the workflows are listed once for a whole answer, whatever the number of verbs', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const { ToolCatalog } = await import('../lib/tool-catalog.mjs');
  const folder = new URL('../runner/workflows/', import.meta.url);
  const workflows = [];
  for (const name of await readdir(folder))
    workflows.push({ ...JSON.parse(await readFile(new URL(name, folder), 'utf8')), ready: true });
  // Each listing checks the files of every workflow: 0.6 s on the machine it was measured on.
  let listed = 0;
  const tools = new ToolCatalog({
    list: async () => {
      listed++;
      return workflows;
    },
  });
  const studio = await tools.studio();
  assert.equal(listed, 1, 'the Studio');
  assert.ok(studio.create_image.length && studio.create_video.length);
  listed = 0;
  const offered = await tools.definitions({ images: 0, resources: [], outputs: [] });
  assert.equal(listed, 1, 'the tools offered to the model');
  assert.ok(offered.length > 1);
  listed = 0;
  assert.ok((await tools.actions()).upscale.length);
  assert.equal(listed, 1, 'the buttons under a creation');
});

test('under the preview: 1:1, 16:9 and 9:16, and a fourth format takes the place of « ··· »', async () => {
  const { shownFormats, resultCount } = await import('../public/studio.mjs');
  const all = ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'];
  assert.deepEqual(shownFormats(all, '16:9'), { main: ['1:1', '16:9', '9:16'], extra: null });
  assert.deepEqual(shownFormats(all, '4:3'), { main: ['1:1', '16:9', '9:16'], extra: '4:3' });
  // A model that cannot make a square shows the two others.
  assert.deepEqual(shownFormats(['16:9', '9:16', '21:9'], '21:9'), { main: ['16:9', '9:16'], extra: '21:9' });
  // The count of the Sortie, in the words of the choice beside it.
  assert.equal(resultCount(0), '');
  assert.equal(resultCount(1), '1 résultat');
  assert.equal(resultCount(3), '3 résultats');
});

test('a proposal of Moodix AI read in the Studio’s terms, with what the assistant may change', async () => {
  const { proposedValues } = await import('../public/studio.mjs');
  const offered = [
    { id: 'ltx', name: 'LTX 2.5', settings: [] },
    { id: 'minimax', name: 'MiniMax H3 Omni', settings: [{ key: 'language' }] },
  ];
  const values = proposedValues(
    {
      tool: 'create_video',
      workflowName: 'MiniMax H3 Omni',
      resolution: { width: 768, height: 448 },
      plan: {
        prompt: 'Un renard se lève',
        stage: 'draft',
        parameters: { width: 768, height: 448, frames: 125, fps: 24, seed: 42, language: 'fr' },
        editable: {
          prompt: true,
          parameters: [
            { key: 'frames', type: 'integer', value: 125, choices: [125, 193] },
            // « Fixe » in the workflow: shown, never changed by the pointer.
            { key: 'width', type: 'integer', value: 768, locked: 'Fixé par le workflow' },
            { key: 'height', type: 'integer', value: 448, locked: 'Fixé par le workflow' },
            { key: 'seed', type: 'integer', value: 42 },
          ],
          references: [[{ role: 'start_image' }, { role: 'reference' }]],
        },
        references: [{ role: 'start_image', resource_id: 'r1', label: 'Renard' }],
      },
    },
    offered,
  );
  assert.equal(values.workflow, 'minimax');
  assert.equal(values.prompt, 'Un renard se lève');
  assert.equal(values.promptFree, true);
  assert.equal(values.format, '16:9');
  assert.equal(values.size, '768x448');
  assert.equal(values.sizeFree, false);
  assert.ok(Math.abs(values.seconds - 125 / 24) < 1e-9);
  assert.equal(values.framesFree, true);
  assert.deepEqual(values.framesChoices, [125, 193]);
  assert.equal(values.seed, 42);
  assert.deepEqual(values.settings, { language: 'fr' });
  assert.deepEqual(values.settingsFree, { language: false });
  assert.equal(values.references.length, 1);
  assert.equal(values.source, null);
  // A continuation: its added length is counted after the overlap with its clip.
  const more = proposedValues(
    {
      tool: 'extend_video',
      workflowName: 'LTX 2.5',
      plan: {
        prompt: 'La suite',
        parameters: { width: 512, height: 288, frames: 73, fps: 24, overlap_frames: 25 },
        editable: { prompt: true, parameters: [] },
        references: [{ role: 'source_video', output_id: 'clip' }],
      },
    },
    offered,
  );
  assert.equal(more.source, 'clip');
  assert.equal(more.seconds, 2);
  assert.deepEqual(more.references, []);
});

test('another mode stops following the size of the frame it leaves', async () => {
  // Just enough of a page for the Studio to draw itself.
  class Element {
    children = [];
    style = {};
    dataset = {};
    classList = { toggle() {}, add() {}, remove() {} };
    append(...nodes) {
      this.children.push(...nodes);
    }
    replaceChildren(...nodes) {
      this.children = nodes;
    }
    add(option) {
      this.children.push(option);
    }
    setAttribute() {}
    removeAttribute() {}
    querySelector() {
      return new Element();
    }
    querySelectorAll() {
      return [];
    }
  }
  const page = Object.fromEntries(['studio-view', 'studio-kinds', 'studio-body'].map(id => [id, new Element()]));
  const observers = [];
  const globals = {
    document: { getElementById: id => page[id] ?? null, querySelector: () => null },
    Option: class {},
    ResizeObserver: class {
      constructor(callback) {
        Object.assign(this, { callback, watched: null });
        observers.push(this);
      }
      observe(target) {
        this.watched = target;
      }
      disconnect() {
        this.watched = null;
      }
    },
  };
  const before = Object.fromEntries(Object.keys(globals).map(key => [key, globalThis[key]]));
  Object.assign(globalThis, globals);
  try {
    const { setupStudio } = await import('../public/studio.mjs');
    const limits = { width: { min: 256, max: 2048, multipleOf: 32 }, height: { min: 256, max: 2048, multipleOf: 32 } };
    const workflow = (id, media) => ({
      id,
      name: id,
      roles: {},
      limits,
      size: { width: 1024, height: 576 },
      settings: [],
      seeded: true,
      media,
    });
    const info = {
      enabled: true,
      legacyId: STUDIO_ID,
      styles: [],
      tools: { create_image: [workflow('i', 'image')], create_video: [workflow('v', 'video')] },
    };
    const studio = setupStudio({
      api: async route => ({ json: async () => (route === 'studio' ? info : { runs: [] }) }),
      node: () => new Element(),
      icon: () => new Element(),
      notice() {},
      assets: {},
      viewOutput() {},
      waitForModel: async () => {},
      blocked: () => '',
      onChange() {},
      conversation: () => 'c1',
    });
    await studio.open();
    // No page of three choices any more: the Studio opens on a mode, Image first.
    assert.equal(page['studio-body'].dataset.mode, 'image');
    assert.deepEqual(
      page['studio-kinds'].children.map(tab => tab.dataset.mode),
      ['image', 'video', 'audio'],
    );
    const following = observers.at(-1);
    assert.ok(following.watched, 'the frame follows its stage');
    page['studio-kinds'].children[1].onclick();
    assert.equal(page['studio-body'].dataset.mode, 'video');
    // Still watched, the stage left was reported once more as it went.
    assert.equal(following.watched, null);
    assert.equal(observers.filter(observer => observer.watched).length, 1);
  } finally {
    Object.assign(globalThis, before);
  }
});

/** A runtime with one image workflow, a chat model and a generator that only note what they are asked. */
function handover({ keepMs, fails = false, tight = false, onRun } = {}) {
  const turn = 'a1111111-1111-4111-8111-111111111111';
  const workflow = {
    schemaVersion: 1,
    id: 'image',
    name: 'Image',
    description: '',
    digest: 'a'.repeat(64),
    mediaType: 'image',
    pipeline: 'krea2',
    enabled: true,
    ready: true,
    parameters: { prompt: { policy: 'model', type: 'string' } },
    references: [],
  };
  const events = [];
  const engine = {
    busy: false,
    state: 'ready',
    stop: async () => {
      events.push('llm stopped');
      engine.state = 'stopped';
    },
    start: async () => {
      events.push('llm started');
      engine.state = 'ready';
    },
  };
  const runtime = new ToolRuntime({
    engine,
    ...(keepMs ? { keepMs } : {}),
    catalog: {
      list: async () => [workflow],
      read: async () => workflow,
      prepare: async () => ({
        workflow,
        job: {
          schemaVersion: 1,
          id: turn,
          pipeline: 'krea2',
          mediaType: 'image',
          workflowId: 'image',
          workflowDigest: workflow.digest,
          parameters: { prompt: 'boat', seed: 1, width: 512, height: 512 },
          components: {},
          loras: [],
          references: [],
        },
        outputNodes: [],
      }),
    },
    gallery: { put: async record => record },
    getConfig: () => ({ enabled: true, autoAllow: false, maxIterations: 5, baseUrl: 'native' }),
    engineConfig: () => ({}),
    clientFactory: () => ({
      status: async () => ({ idle: true }),
      preflight: async () => {},
      run: async (job, options) => {
        events.push('generate');
        await onRun?.(options);
        if (fails) throw Error('Mémoire vidéo insuffisante.');
        return { outputs: [{ filename: 'image.png', subfolder: '', type: 'output' }] };
      },
      // Asked to stay loaded, the generator does so unless main memory is short with its models in it.
      free: async options => {
        const kept = Boolean(options?.keep) && !tight;
        events.push(kept ? 'sources removed' : 'gpu released');
        return kept ? { kept: true } : {};
      },
    }),
  });
  /** One image asked from this conversation, run to its end; `studio`: started in its Studio. */
  async function create(conversationId, { studio = false } = {}) {
    const request = await runtime.request(
      [{ id: 'call', type: 'function', function: { name: 'create_image', arguments: '{"prompt":"boat"}' } }],
      { conversationId, turnId: turn, messages: [] },
    );
    await runtime.execute({ requestId: request.requestId, permission: 'once', ...(studio ? { studio } : {}) });
    await runtime.finished;
    return runtime.status();
  }
  return { runtime, events, create, turn };
}

test('a Studio generation unloads the chat model and leaves it unloaded; a conversation gets it back', async () => {
  for (const studio of [true, false]) {
    const { runtime, events, create, turn } = handover();
    const status = await create(studio ? STUDIO_ID : turn);
    assert.equal(status.state, 'done', status.error);
    assert.deepEqual(
      events,
      studio
        ? // The generator stays loaded for the next creation: only the copies of the sources go.
          ['llm stopped', 'generate', 'sources removed']
        : ['llm stopped', 'generate', 'gpu released', 'llm started'],
    );
    // The chat model is wanted (a message, a style): the card is given back first, once.
    events.length = 0;
    assert.equal(await runtime.yieldGpu(), studio);
    assert.deepEqual(events, studio ? ['gpu released'] : []);
    assert.equal(await runtime.yieldGpu(), false);
    await runtime.close();
  }
});

test('in a conversation, a creation started from its Studio keeps the generator and leaves the chat model unloaded', async () => {
  const { runtime, events, create, turn } = handover();
  const status = await create(turn, { studio: true });
  assert.equal(status.state, 'done', status.error);
  // The user may well make another one at once: nothing reloads, only the copies of the sources go.
  assert.deepEqual(events, ['llm stopped', 'generate', 'sources removed']);
  // The next message of the chat gives the card back first.
  events.length = 0;
  assert.equal(await runtime.yieldGpu(), true);
  assert.deepEqual(events, ['gpu released']);
  await runtime.close();
});

test('the generator a Studio creation left loaded gives the card back by itself after a while', async () => {
  const { runtime, events, create } = handover({ keepMs: 40 });
  await create(STUDIO_ID);
  await create(STUDIO_ID);
  // Two creations in a row: nothing was unloaded between them.
  assert.deepEqual(events, [
    'llm stopped',
    'generate',
    'sources removed',
    'llm stopped',
    'generate',
    'sources removed',
  ]);
  events.length = 0;
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.deepEqual(events, ['gpu released']);
  assert.equal(await runtime.yieldGpu(), false);
  await runtime.close();
});

test('a generator that leaves the machine short of main memory is not kept loaded', async () => {
  // A video model: seventeen gigabytes of main memory beside the card, three left out of thirty-two.
  const { runtime, events, create } = handover({ tight: true });
  const status = await create(STUDIO_ID);
  assert.equal(status.state, 'done', status.error);
  assert.deepEqual(events, ['llm stopped', 'generate', 'gpu released']);
  // Nothing is left to give back later, and the chat model still stays away.
  assert.equal(await runtime.yieldGpu(), false);
  assert.deepEqual(events, ['llm stopped', 'generate', 'gpu released']);
  await runtime.close();
});

test('a failed Studio creation, a conversation or closing give the whole card back', async () => {
  // A failure may have left the card full: nothing is kept after it.
  const failed = handover({ fails: true });
  const status = await failed.create(STUDIO_ID);
  assert.equal(status.state, 'error');
  assert.deepEqual(failed.events, ['llm stopped', 'generate', 'gpu released']);
  assert.equal(await failed.runtime.yieldGpu(), false);
  await failed.runtime.close();

  // A creation asked in a conversation ends with the chat model back: what the Studio left
  // loaded leaves before it, with the generator of that creation.
  const mixed = handover();
  await mixed.create(STUDIO_ID);
  mixed.events.length = 0;
  await mixed.create(mixed.turn);
  assert.deepEqual(mixed.events, ['llm stopped', 'generate', 'gpu released', 'gpu released', 'llm started']);
  await mixed.runtime.close();

  // Closing the application does not leave the generator holding the card.
  const closed = handover();
  await closed.create(STUDIO_ID);
  closed.events.length = 0;
  await closed.runtime.close();
  assert.deepEqual(closed.events, ['gpu released']);
});

test('the picture the generator has so far is kept one at a time, and dropped with the job', async () => {
  const first = { bytes: Buffer.from([0xff, 0xd8, 0xff, 1]), mime: 'image/jpeg' },
    second = { bytes: Buffer.from([0xff, 0xd8, 0xff, 2]), mime: 'image/jpeg' };
  let during;
  const { runtime, create } = handover({
    onRun: ({ onProgress }) => {
      onProgress({ stage: 'generating', step: 1, total: 8 });
      const before = runtime.status();
      onProgress({ preview: first });
      onProgress({ preview: second });
      const { id, preview, progress } = runtime.status();
      during = { before: before.preview, preview, progress, kept: runtime.preview(id), other: runtime.preview('x') };
    },
  });
  const status = await create(STUDIO_ID);
  // Its number only goes with the status; the bytes are asked for apart, for this job alone.
  assert.equal(during.before, undefined);
  assert.equal(during.preview, 2);
  assert.deepEqual(during.kept, { ...second, seq: 2 });
  assert.equal(during.other, null);
  // A picture is not a stage of the work: the progress line is not touched by it.
  assert.doesNotMatch(String(during.progress), /preview|object/i);
  // Once the creation is there, nothing of it stays in memory.
  assert.equal(status.preview, undefined);
  assert.equal(runtime.preview(status.id), null);
  await runtime.close();
});

/** A page that remembers what each element is, with the Studio set up in it; `routes` answers its requests. */
async function studioPage(tools, routes = {}, options = {}) {
  class Element {
    constructor(tag = '', className = '', textContent = '') {
      Object.assign(this, { tag, className, textContent, children: [], style: {}, dataset: {} });
      this.classList = { toggle() {}, add() {}, remove() {} };
    }
    append(...nodes) {
      this.children.push(...nodes);
    }
    replaceChildren(...nodes) {
      this.children = nodes;
    }
    add(option) {
      this.children.push(option);
    }
    setAttribute(name, value) {
      (this.attributes ??= {})[name] = value;
    }
    removeAttribute(name) {
      delete this.attributes?.[name];
    }
    querySelector() {
      return new Element();
    }
    querySelectorAll() {
      return [];
    }
    addEventListener(type, listener) {
      (this.listeners ??= {})[type] = listener;
    }
    click() {
      this.clicks = (this.clicks ?? 0) + 1;
    }
    /** Every element under this one whose classes include `name`. */
    find(name) {
      return this.children.flatMap(child =>
        child instanceof Element
          ? [...(child.className.split(' ').includes(name) ? [child] : []), ...child.find(name)]
          : [],
      );
    }
  }
  const page = Object.fromEntries(
    ['studio-view', 'studio-kinds', 'studio-body', 'ai-status', 'ai-takeover'].map(id => [id, new Element()]),
  );
  // The pointer of Moodix AI (options.cursor: the list where what it says is written).
  if (options.cursor) {
    const classes = new Set();
    page['ai-cursor'] = {
      hidden: true,
      style: { setProperty() {} },
      classList: {
        add: name => classes.add(name),
        remove: name => classes.delete(name),
        toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
        contains: name => classes.has(name),
      },
      querySelector: () => null,
    };
    page['ai-cursor-text'] = {
      set textContent(label) {
        if (label) options.cursor.push(label);
      },
    };
  }
  // What the page itself listens to: keys pressed with the focus on no field.
  const pageKeys = [],
    pagePointers = [];
  const globals = {
    document: {
      getElementById: id => page[id] ?? null,
      // A setting the pointer goes to (options.targets): somewhere on the page.
      querySelector: options.targets
        ? () => ({
            getBoundingClientRect: () => ({ left: 100, top: 100, width: 40, height: 40 }),
            scrollIntoView() {},
            style: { setProperty() {} },
          })
        : () => null,
      body: {},
      addEventListener: (type, listener) =>
        type === 'keydown' ? pageKeys.push(listener) : type === 'pointerdown' && pagePointers.push(listener),
    },
    Option: class {},
    ResizeObserver: undefined,
  };
  const before = Object.fromEntries(Object.keys(globals).map(key => [key, globalThis[key]]));
  Object.assign(globalThis, globals);
  const { setupStudio } = await import('../public/studio.mjs');
  const asked = [],
    notices = [],
    revealed = [];
  let imported = 0;
  const runs = options.runs ?? [];
  const studio = setupStudio({
    api: async (route, body) => {
      asked.push([route, body]);
      return {
        json: async () =>
          route === 'studio'
            ? {
                enabled: true,
                legacyId: STUDIO_ID,
                styles: ['a.safetensors', 'b.safetensors'],
                tools,
                presets: options.presets ?? {},
              }
            : route.startsWith('gallery/') || route.startsWith('project-gallery/')
              ? {
                  runs: route.includes(STUDIO_ID) ? (options.legacy ?? []) : runs,
                  ...(options.nextTake ? { nextTake: options.nextTake } : {}),
                }
              : (routes[route]?.(body) ?? {}),
      };
    },
    node: (tag, className, text) => new Element(tag, className, text),
    icon: glyph => Object.assign(new Element('svg'), { glyph }),
    notice: text => notices.push(text),
    // Each file dropped becomes a reference of the project, with its own preview.
    assets: {
      importFiles: async (files, kept) => {
        importedInto.push(kept?.project);
        return files.map(file => ({
          id: 'r' + ++imported,
          label: '#ref' + imported,
          name: file.name,
          previewUrl: '/preview/' + file.name,
          width: 1280,
          height: 720,
        }));
      },
      resource: options.resource ?? (id => ({ previewUrl: '/preview/' + id })),
    },
    viewOutput: options.viewOutput ?? (() => {}),
    waitForModel: async () => {},
    blocked: () => '',
    onChange() {},
    // `null`: a conversation not begun; nothing said, « c1 ».
    conversation: () => (options.conversation?.() === null ? null : (options.conversation?.() ?? 'c1')),
    ...(options.project ? { project: options.project } : {}),
    ensureConversation: async () => options.conversation?.() ?? 'c1',
    reveal: () => revealed.push(true),
    pace: 0,
    ...(options.run ? { run: options.run } : {}),
    ...(options.openAgent ? { openAgent: options.openAgent } : {}),
    ...(options.openStudio ? { openStudio: options.openStudio } : {}),
  });
  if (options.open !== false) await studio.open();
  return {
    studio,
    page,
    body: page['studio-body'],
    asked,
    notices,
    revealed,
    pageKeys,
    pagePointers,
    runs,
    restore: () => Object.assign(globalThis, before),
    /** Opens a mode by its place among Image, Vidéo and Son. */
    mode: index => page['studio-kinds'].children[index].onclick(),
    /** The prompt of the Entrée block. */
    prompt: () => page['studio-body'].find('studio-prompt-field')[0].children[0],
  };
}
const sizes = { width: { min: 256, max: 2048, multipleOf: 32 }, height: { min: 256, max: 2048, multipleOf: 32 } };
const settle = () => new Promise(resolve => setTimeout(resolve, 15));

test('Image, Vidéo and Son at the top of the screen: icons named, there from the start, opening the Studio in their mode', async () => {
  const image = { id: 'i', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] },
    video = { id: 'v', name: 'Clip', roles: {}, limits: sizes, size: { width: 768, height: 448 }, settings: [] };
  const opened = [];
  const { page, body, restore } = await studioPage(
    { create_image: [image], create_video: [video] },
    {},
    { open: false, openStudio: () => opened.push(true) },
  );
  try {
    // Drawn before the Studio is ever opened: the sidebar shows them from the Chat too.
    const tabs = page['studio-kinds'].children;
    assert.deepEqual(
      tabs.map(tab => [tab.attributes.role, tab.attributes['aria-label'], tab.title, tab.children.at(-1).textContent]),
      [
        ['tab', 'Image', 'Image', 'Image'],
        ['tab', 'Vidéo', 'Vidéo', 'Vidéo'],
        ['tab', 'Son', 'Son', 'Son'],
      ],
      'an icon each and its name (shown beside it for the one chosen), for screen readers and in its tooltip',
    );
    assert.equal(tabs[0].attributes['aria-selected'], 'true');
    // From the Chat: the mode is chosen as the selector of the Studio did, and the Studio opens.
    tabs[1].onclick();
    assert.equal(body.dataset.mode, 'video');
    assert.equal(opened.length, 1);
    // In the Studio: the mode changes, nothing else opens.
    globalThis.document.body.dataset = { view: 'studio' };
    tabs[0].onclick();
    assert.equal(body.dataset.mode, 'image');
    assert.equal(opened.length, 1);
    // The arrows go from one mode to the next, along the row or down the column.
    page['studio-kinds'].onkeydown({ key: 'ArrowDown', preventDefault() {} });
    assert.equal(body.dataset.mode, 'video');
    page['studio-kinds'].onkeydown({ key: 'ArrowLeft', preventDefault() {} });
    assert.equal(body.dataset.mode, 'image');
  } finally {
    restore();
  }
});

test('the last creation stays on the screen; another conversation starts from an empty screen', async () => {
  const workflow = {
    id: 'w',
    name: 'Image',
    roles: {},
    limits: sizes,
    direct: true,
    size: { width: 1024, height: 1024 },
    settings: [],
    seeded: true,
  };
  const made = { id: 'r1', prompt: 'un phare', outputs: [{ originalUrl: '/media/generated/phare' }] };
  const opened = [];
  let conversation = 'c1';
  const page = await studioPage(
    { create_image: [workflow] },
    {
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => {
        // The creation is made at once, and listed by the gallery from then on.
        page.runs.unshift(made);
        return { id: 'j', state: 'done', record: made };
      },
    },
    { viewOutput: record => opened.push(record.id), conversation: () => conversation },
  );
  const { body, studio, asked, restore } = page;
  try {
    assert.deepEqual(body.find('studio-frame-result'), [], 'an empty screen to begin with');
    page.prompt().value = 'un phare';
    page.prompt().oninput();
    await body.find('studio-go')[0].onclick();
    // Made in the conversation, as a creation of its Studio.
    const [, action] = asked.find(([route]) => route === 'tools/action');
    assert.equal(action.conversationId, 'c1');
    assert.equal(action.studio, true);
    assert.equal(asked.find(([route]) => route === 'tools/execute')[1].studio, true);
    const [kept] = body.find('studio-frame-result');
    assert.equal(kept.tag, 'img');
    assert.equal(kept.src, '/media/generated/phare');
    assert.match(body.find('studio-frame')[0].className, /has-result/);
    // A click shows it whole, with its settings.
    kept.onclick();
    assert.deepEqual(opened, ['r1']);
    // In the Sortie, without a count (moodix-design.md 23); on the screen still after a visit of the chat.
    assert.equal(body.find('studio-item').length, 1);
    assert.deepEqual(body.find('studio-count'), []);
    // A creation is shown as it is, with no grain over it; its actions sit on its picture, so the
    // Sortie keeps its height. No title on the blocks: their colour says what they are for.
    assert.deepEqual(body.find('picture-grain'), []);
    assert.equal(body.find('studio-item')[0].find('studio-item-del').length, 1);
    assert.deepEqual(body.find('studio-block-title'), []);
    await studio.open();
    assert.equal(body.find('studio-frame-result').length, 1);
    // Another conversation: its own Studio, an empty screen.
    conversation = 'c2';
    page.runs.length = 0;
    await studio.open();
    assert.deepEqual(body.find('studio-frame-result'), []);
    assert.equal(body.find('studio-item').length, 0);
  } finally {
    restore();
  }
});

test('« Ouvrir » on a card puts the creation on the screen of its mode', async () => {
  const video = {
    id: 'v',
    name: 'Clip',
    roles: {},
    limits: sizes,
    size: { width: 768, height: 448 },
    settings: [],
    seeded: true,
  };
  const clip = { id: 'c', mediaType: 'video', prompt: 'un renard', outputs: [{ originalUrl: '/clip.mp4' }] },
    picture = { id: 'p', prompt: 'un terrier', outputs: [{ originalUrl: '/p.png' }] };
  const { studio, body, restore } = await studioPage({ create_video: [video] }, {}, { runs: [picture, clip] });
  try {
    // The Studio opens on the mode of the newest take of the conversation: an image.
    assert.equal(body.dataset.mode, 'image');
    studio.show(clip);
    assert.equal(body.dataset.mode, 'video');
    const [shown] = body.find('studio-frame-result');
    assert.equal(shown.tag, 'video');
    // Its picture and a round play button (capture 22); the controls once it plays.
    assert.equal(shown.controls, false);
    assert.equal(body.find('take-play').length, 1);
    shown.playButton.onclick();
    assert.equal(shown.controls, true, 'a clip plays on the screen');
    assert.match(body.find('studio-item').find(tile => tile.dataset.id === 'c').className, /is-shown/);
  } finally {
    restore();
  }
});

test('the screen takes the format chosen, the take whole in it, « PRISE n » on it; while one is made, the number to come', async () => {
  const video = { id: 'v', name: 'Clip', roles: {}, limits: sizes, size: { width: 768, height: 448 }, settings: [], seeded: true };
  // A square clip while 16:9 is the format chosen: the screen is 16:9, the clip whole inside (16/11).
  const clip = {
    id: 'c',
    mediaType: 'video',
    prompt: 'un renard',
    outputs: [{ originalUrl: '/clip.mp4', take: 4 }],
    parameters: { width: 512, height: 512, frames: 145, fps: 24 },
  };
  let page = await studioPage({ create_video: [video] }, {}, { runs: [clip] });
  try {
    const { studio, body } = page;
    studio.show(clip);
    const [frame] = body.find('studio-frame');
    const [width, height] = [frame.style.width, frame.style.height].map(value => parseFloat(value));
    assert.ok(Math.abs(width / height - 16 / 9) < 0.02, `16:9 with a square take in it (${width} × ${height})`);
    const [label] = body.find('studio-frame-label');
    assert.equal(label.textContent, 'PRISE 4');
    assert.equal(label.className, 'studio-frame-label is-take');
    // The readout says the format chosen, which the screen has.
    assert.match(body.find('studio-readout')[0].textContent, /^16:9/);
  } finally {
    page.restore();
  }
  // While a take is made: the number it will have (the counter of the project), in the accent.
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, direct: true, size: { width: 1024, height: 1024 }, settings: [], seeded: true };
  let finish;
  page = await studioPage(
    { create_image: [image] },
    {
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => ({ id: 'j', state: 'running', progress: 'Génération…' }),
      'tools/job': () =>
        new Promise(resolve => {
          finish = () => resolve({ id: 'j', state: 'error', error: 'rien' });
        }),
    },
    { runs: [{ id: 'p', prompt: 'un phare', outputs: [{ originalUrl: '/p.png', take: 30 }] }], nextTake: 32 },
  );
  try {
    const { body } = page;
    page.prompt().value = 'un phare';
    page.prompt().oninput();
    const made = body.find('studio-go')[0].onclick();
    // Asked for its state after a pause of the Studio (0,7 s).
    for (let tries = 0; !finish && tries < 120; tries++) await settle();
    const [label] = body.find('studio-frame-label');
    assert.equal(label.textContent, 'PRISE 32', 'its counter, not the last take + 1 (a take deleted keeps its number)');
    assert.equal(label.className, 'studio-frame-label is-take is-coming');
    finish();
    await made;
    await settle();
    assert.equal(body.find('studio-frame-label')[0].textContent, 'PRISE 30', 'done: the last take again');
  } finally {
    page.restore();
  }
});

test('in the Sortie a clip is a strip as long as it lasts, a sound a card', async () => {
  const video = { id: 'v', name: 'Clip', roles: {}, limits: sizes, size: { width: 768, height: 448 }, settings: [], seeded: true },
    sound = { id: 'a', name: 'ACE-Step', roles: {}, settings: [{ key: 'seconds', default: 30 }] },
    runs = [
      {
        id: 'song',
        mediaType: 'audio',
        workflowName: 'ACE-Step 1.5',
        prompt: 'Brume d’automne\nau piano',
        outputs: [{ originalUrl: '/song.wav', take: 9 }],
        parameters: { seconds: 105 },
      },
      { id: 'rain', mediaType: 'audio', workflowName: 'MOSS-SFX', prompt: 'La pluie', outputs: [{ originalUrl: '/rain.wav' }], parameters: { seconds: 8 } },
      {
        id: 'clip',
        mediaType: 'video',
        prompt: 'un renard',
        outputs: [{ originalUrl: '/clip.mp4', thumbUrl: '/clip.jpg', take: 7 }],
        parameters: { width: 448, height: 768, frames: 145, fps: 24 },
      },
    ];
  const page = await studioPage({ create_video: [video], create_audio: [sound] }, {}, { runs });
  try {
    const { body } = page;
    // The Sortie shows them all, whatever the mode (16/11): the clip a strip, the sounds cards.
    page.mode(1);
    const strip = body.find('studio-item').find(tile => tile.dataset.id === 'clip');
    assert.equal(strip.dataset.media, 'video');
    assert.doesNotMatch(strip.className, /is-sound/);
    page.mode(2);
    const cards = body.find('studio-item').filter(tile => tile.dataset.media === 'audio');
    assert.deepEqual(cards.map(card => card.dataset.id), ['song', 'rain']);
    assert.match(cards[0].className, /is-sound/);
    assert.deepEqual(
      cards.map(card => card.find('studio-sound-head')[0].children.map(part => part.textContent)),
      [
        ['PRISE 9 · 1:45', 'MUSIQUE'],
        ['#2 · 08.00 S', 'BRUITAGE'],
      ],
    );
    assert.deepEqual(cards.map(card => card.find('studio-sound-name')[0].textContent), ['Brume d’automne', 'La pluie']);
  } finally {
    page.restore();
  }
});

test('the creations of the former Studio are no longer shown, nothing chooses them; empty, the Sortie says so', async () => {
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] };
  const old = { id: 'o', prompt: 'avant', outputs: [{ originalUrl: '/old.png' }] };
  const { body, restore } = await studioPage({ create_image: [image] }, {}, { legacy: [old] });
  try {
    // moodix-design.md 7 bis 7: no « Cette conversation / Ancien Studio »; their files stay in output.
    assert.deepEqual(body.find('studio-source-pick'), []);
    assert.equal(body.find('studio-item').length, 0);
    // What the Sortie will hold, in words alone (etats-maquette.md, 55).
    const [empty] = body.find('studio-empty-strip');
    assert.equal(empty.children[0].textContent, 'Rien pour l’instant. Vos images apparaîtront ici, la dernière à gauche.');
  } finally {
    restore();
  }
});

test('the Sortie: pictures only, the newest at the left with the largest number, their actions on them', async () => {
  const image = {
      id: 'i',
      name: 'Image',
      styled: true,
      limits: sizes,
      size: { width: 1024, height: 1024 },
      settings: [],
      seeded: true,
      roles: { source: { count: 1, media: ['image'] } },
    },
    video = {
      id: 'v',
      name: 'Clip',
      styled: true,
      limits: sizes,
      size: { width: 768, height: 448 },
      settings: [],
      seeded: true,
      roles: { start_image: { count: 1, media: ['image'] }, reference: { count: 2, media: ['image'] } },
      exclusive: [['start_image'], ['reference']],
    },
    runs = [
      {
        id: 'p2',
        prompt: 'un phare',
        outputs: [{ originalUrl: '/p2.png' }],
        parameters: { width: 1024, height: 1024 },
      },
      {
        id: 'c2',
        mediaType: 'video',
        prompt: 'la suite',
        outputs: [{ originalUrl: '/c2.mp4' }],
        parameters: { references: [{ role: 'source_video', output_id: 'c1' }] },
      },
      {
        id: 'p1',
        prompt: 'un renard',
        outputs: [{ originalUrl: '/p1.png' }],
        parameters: { width: 1024, height: 1024 },
      },
      { id: 'c1', mediaType: 'video', prompt: 'un renard qui court', outputs: [{ originalUrl: '/c1.mp4' }] },
    ];
  const opened = [];
  const { body, restore, mode, asked } = await studioPage(
    { create_image: [image], create_video: [video] },
    {},
    { runs, viewOutput: record => opened.push(record.id) },
  );
  try {
    const items = () => body.find('studio-item'),
      numbers = () => body.find('studio-item-number').map(badge => badge.textContent),
      references = () => body.find('studio-slot-badge').map(badge => badge.textContent);
    // Its button released: the kind of the mode only.
    body.find('studio-sort-go')[0].onclick();
    // The kind of the mode (16/11), the newest at the left, numbered with the others (never two
    // « #1 »); under each its number (« PRISE n » once it has one), a continuation « ↳ SUITE »
    // (studio-maquette.md); no title (their names are for screen readers and in their tooltips).
    assert.deepEqual(numbers(), ['#4', '#2']);
    assert.deepEqual(body.find('studio-item-title'), []);
    assert.deepEqual(body.find('studio-caption'), []);
    assert.equal(items()[0].find('studio-item-pick')[0].attributes['aria-label'], 'Image #4 · un phare');
    // The wheel scrolls it sideways, the pointer anywhere over it; a sideways move is the
    // browser's, and nothing moves when all of it shows.
    const [sortie] = body.find('is-output'),
      [strip] = body.find('studio-strip');
    Object.assign(strip, { scrollLeft: 0, scrollWidth: 1200, clientWidth: 400 });
    let stopped = 0;
    const wheel = (deltaY, deltaX = 0, deltaMode = 0) =>
      sortie.onwheel({ deltaY, deltaX, deltaMode, preventDefault: () => stopped++ });
    wheel(100);
    wheel(3, 0, 1);
    assert.equal(strip.scrollLeft, 220);
    assert.equal(stopped, 2);
    wheel(10, 80);
    assert.equal(strip.scrollLeft, 220);
    strip.scrollWidth = 400;
    wheel(100);
    assert.deepEqual([strip.scrollLeft, stopped], [220, 2]);
    // In Vidéo, the clips.
    mode(1);
    assert.deepEqual(numbers(), ['↳ SUITE', '#1']);
    // A clip: its continuation said too; « Prolonger » is its round button; no « Lire ».
    assert.equal(
      items()[0].find('studio-item-pick')[0].attributes['aria-label'],
      'Clip #3 · suite du clip #1 · la suite',
    );
    assert.equal(items()[0].find('studio-item-main')[0].attributes['aria-label'], 'Prolonger · Clip #3');
    assert.deepEqual(body.find('studio-play'), []);
    // The screen shows the last clip; it is ringed in the Sortie.
    assert.match(items()[0].className, /is-shown/);
    assert.doesNotMatch(items()[1].className, /is-shown/);
    // A click shows it whole with its details; the screen keeps the last clip. No « i » on the picture.
    items()[1].find('studio-item-pick')[0].onclick();
    assert.deepEqual(opened, ['c1']);
    assert.match(items()[0].className, /is-shown/);
    assert.deepEqual(body.find('studio-item-info'), []);
    // A right click: every action in a menu; « Détails » is the same view; « Supprimer » asks on the
    // picture before anything goes.
    items()[0].oncontextmenu({ preventDefault() {} });
    body.find('studio-item-menu')[0].children[1].onclick();
    assert.deepEqual(opened, ['c1', 'c2']);
    items()[0].oncontextmenu({ preventDefault() {} });
    const [menu] = body.find('studio-item-menu');
    assert.equal(menu.attributes.role, 'menu');
    assert.deepEqual(
      menu.children.map(entry => entry.children.at(-1).textContent),
      ['Prolonger', 'Détails', 'Supprimer'],
    );
    menu.children[2].onclick();
    assert.deepEqual(body.find('studio-item-menu'), []);
    const [ask] = body.find('studio-item-confirm');
    assert.equal(ask.attributes.role, 'alertdialog');
    assert.equal(ask.find('studio-confirm-text')[0].textContent, 'Supprimer #3 ?');
    // ✕ keeps it.
    ask.find('studio-confirm-no')[0].onclick();
    assert.deepEqual(body.find('studio-item-confirm'), []);
    assert.equal(asked.filter(([route]) => route === 'studio/delete').length, 0);
    // The bin, then the light one: it goes.
    items()[0].find('studio-item-del')[0].onclick();
    body.find('studio-confirm-yes')[0].onclick();
    await settle();
    assert.equal(asked.find(([route]) => route === 'studio/delete')[1].id, 'c2');

    // « Animer »: the picture goes to the references of the first video model, once.
    mode(0);
    assert.equal(items()[0].find('studio-item-main')[0].attributes['aria-label'], 'Animer · Image #4');
    items()[0].find('studio-item-main')[0].onclick();
    assert.equal(body.dataset.mode, 'video');
    assert.deepEqual(references(), ['@1']);
    mode(0);
    items()[0].find('studio-item-main')[0].onclick();
    assert.deepEqual(references(), ['@1'], 'there already: nothing is added');
    mode(0);
    items()[1].find('studio-item-main')[0].onclick();
    assert.deepEqual(references(), ['@1', '@2']);
    // An image's menu keeps « Modifier » (a model of images takes one to start from).
    mode(0);
    items()[0].oncontextmenu({ preventDefault() {} });
    assert.deepEqual(
      body.find('studio-item-menu')[0].children.map(entry => entry.children.at(-1).textContent),
      ['Animer', 'Modifier', 'Détails', 'Supprimer'],
    );
  } finally {
    restore();
  }
});

test('in the Sortie, an upscale or an interpolation of a clip is said so, with its whole length, not « ↳ SUITE »', async () => {
  const video = {
      id: 'v',
      name: 'Clip',
      styled: true,
      limits: sizes,
      size: { width: 768, height: 448 },
      settings: [],
      seeded: true,
      roles: { start_image: { count: 1, media: ['image'] } },
    },
    from = id => [{ role: 'source_video', output_id: id }],
    runs = [
      // Interpolated from the upscale, then a real continuation of it, then the upscale of the first.
      {
        id: 'c4',
        mediaType: 'video',
        prompt: 'un renard qui court',
        outputs: [{ originalUrl: '/c4.mp4', take: 24 }],
        parameters: { pipeline: 'ltx25', frames: 121, fps: 24, overlap_frames: 25, references: from('c3') },
      },
      {
        id: 'c3',
        mediaType: 'video',
        prompt: 'un renard qui court',
        outputs: [{ originalUrl: '/c3.mp4', take: 23 }],
        parameters: { pipeline: 'rife', mode: 'smooth', frames: 241, fps: 48, references: from('c2') },
      },
      {
        id: 'c2',
        mediaType: 'video',
        prompt: 'un renard qui court',
        outputs: [{ originalUrl: '/c2.mp4', take: 22 }],
        parameters: { pipeline: 'realesrgan_video', frames: 121, fps: 24, references: from('c1') },
      },
      {
        id: 'c1',
        mediaType: 'video',
        prompt: 'un renard qui court',
        outputs: [{ originalUrl: '/c1.mp4', take: 21 }],
        parameters: { pipeline: 'ltx25', frames: 121, fps: 24 },
      },
    ];
  const { body, restore, mode } = await studioPage({ create_video: [video] }, {}, { runs });
  try {
    body.find('studio-sort-go')[0].onclick();
    mode(1);
    const items = body.find('studio-item'),
      captions = items.map(item => item.find('studio-item-caption')[0].children.map(part => part.textContent));
    assert.deepEqual(captions, [
      ['↳ SUITE', '+04.00 S'],
      ['↳ INTERPOLÉE', '05.02 S'],
      ['↳ AGRANDIE', '05.04 S'],
      ['PRISE 21', '05.04 S'],
    ]);
    assert.deepEqual(
      items.slice(0, 3).map(item => item.find('studio-item-pick')[0].attributes['aria-label']),
      [
        'Clip #4 · suite du clip #3 · un renard qui court',
        'Clip #3 · interpolation du clip #2 · un renard qui court',
        'Clip #2 · agrandissement du clip #1 · un renard qui court',
      ],
    );
  } finally {
    restore();
  }
});

test('an image dragged to another slot changes role; a move that would not combine is refused', async () => {
  const video = {
    id: 'v',
    name: 'Clip',
    styled: true,
    limits: sizes,
    size: { width: 768, height: 448 },
    settings: [],
    seeded: true,
    // As MiniMax: a start and an end, or references, never both.
    exclusive: [['start_image', 'end_image'], ['reference']],
    roles: {
      start_image: { count: 1, media: ['image'] },
      end_image: { count: 1, media: ['image'] },
      reference: { count: 2, media: ['image'] },
    },
  };
  const { body, restore, mode } = await studioPage({ create_video: [video] });
  try {
    mode(1);
    const slots = () => body.find('studio-slot'),
      shown = () => slots().map(tile => (tile.className.includes('is-filled') ? tile.children[0].children[0].src : '')),
      event = files => ({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files, setData() {} } }),
      drop = async (index, name) => {
        slots()[index].ondrop(event([{ name }]));
        await new Promise(resolve => setTimeout(resolve, 5));
      },
      drag = (from, to) => {
        slots()[from].children[0].ondragstart(event([]));
        slots()[to].ondrop(event([]));
      };
    assert.equal(slots().length, 3, 'start, end, and one empty reference slot at a time');

    await drop(0, 'a.png');
    assert.deepEqual(shown(), ['/preview/a.png', '', '']);
    // References do not combine with a start image: their slots say so, and still take the move.
    assert.match(slots()[2].className, /is-blocked/);
    drag(0, 2);
    assert.deepEqual(shown(), ['', '', '/preview/a.png', '']);
    assert.doesNotMatch(slots()[2].className, /is-blocked/);
    assert.match(slots()[0].className, /is-blocked/);

    // To the end slot, then a start image beside it: the two swap when one is dropped on the other.
    drag(2, 1);
    await drop(0, 'b.png');
    assert.deepEqual(shown(), ['/preview/b.png', '/preview/a.png', '']);
    drag(0, 1);
    assert.deepEqual(shown(), ['/preview/a.png', '/preview/b.png', '']);

    // A reference beside an end image is what the model cannot take: nothing moves, and it is said.
    drag(0, 2);
    assert.deepEqual(shown(), ['/preview/a.png', '/preview/b.png', '']);
    assert.match(body.find('studio-error')[0].textContent, /ne se combine pas avec : Image de fin/);
  } finally {
    restore();
  }
});

test('the input images: pictos and no word, start and end on a line of time, references numbered without holes', async () => {
  const lengths = { seconds: [121 / 24, 193 / 24, 241 / 24], standard: 121 / 24 },
    video = {
      id: 'v',
      name: 'Clip',
      styled: true,
      limits: sizes,
      size: { width: 768, height: 448 },
      settings: [],
      seeded: true,
      lengths,
      exclusive: [['start_image', 'end_image'], ['reference']],
      roles: {
        start_image: { count: 1, media: ['image'] },
        end_image: { count: 1, media: ['image'] },
        reference: { count: 3, media: ['image'] },
      },
    },
    // A model that takes a start image only.
    other = { ...video, id: 'w', name: 'Autre', exclusive: [], roles: { start_image: { count: 1, media: ['image'] } } };
  const { body, restore, mode } = await studioPage({ create_video: [video, other] });
  try {
    mode(1);
    const slots = () => body.find('studio-slot'),
      picks = () => body.find('studio-slot-pick'),
      shown = () => slots().map(tile => (tile.className.includes('is-filled') ? tile.children[0].children[0].src : '')),
      badges = () => body.find('studio-slot-badge').map(badge => badge.textContent),
      event = files => ({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files, setData() {} } }),
      drop = async (index, name) => {
        slots()[index].ondrop(event([{ name }]));
        await new Promise(resolve => setTimeout(resolve, 5));
      },
      model = id => {
        const pick = body.find('studio-model-pick')[0];
        pick.value = id;
        pick.onchange();
      };
    // Two blocks: the start and the end, the references below; none says « is-flash » yet.
    const [frames, references] = body.find('studio-input-block');
    assert.equal(frames.attributes['aria-label'], 'Début et fin');
    assert.equal(references.attributes['aria-label'], 'Références');
    assert.doesNotMatch(frames.className, /is-flash/);
    // No word under the images: their names are for screen readers and in the tooltips.
    assert.deepEqual(body.find('studio-slot-label'), []);
    assert.deepEqual(
      picks().map(pick => pick.attributes['aria-label']),
      ['Ajouter l’image de début', 'Ajouter l’image de fin', 'Ajouter la référence 1'],
    );
    assert.equal(picks()[1].title, 'Image de fin (facultatif) · glisser, coller ou cliquer');
    // Empty, the start and the end show their pictos, a reference « @ ».
    assert.equal(picks()[0].children[0].tag, 'svg');
    assert.equal(picks()[2].children[0].textContent, '@');

    // The length set, on the line, in the colour of the duration bar: the ivory of the room.
    const [time] = body.find('studio-span-time'),
      [line] = body.find('studio-span-line');
    assert.equal(time.textContent, '05.04 S');
    assert.equal(time.style.color, 'rgb(238, 232, 222)');
    // The bar moved to the longest: the line follows at once, without drawing the Studio again.
    const bar = body.find('studio-bar').find(item => item.dataset.ai === 'duration');
    bar.value = '2';
    bar.oninput();
    assert.equal(time.textContent, '10.04 S');
    assert.equal(time.style.color, 'rgb(238, 232, 222)');
    assert.equal(line.style.backgroundSize, '100% 100%');

    // A start image: its picto stays, small, in a badge; « ⇄ » swaps it to the end and back.
    await drop(0, 'a.png');
    assert.equal(slots()[0].find('studio-slot-badge').length, 1);
    assert.equal(picks()[0].attributes['aria-label'], 'Image de début · #ref1 · a.png');
    const [swap] = body.find('studio-swap');
    assert.equal(swap.attributes['aria-label'], 'Inverser début et fin');
    swap.onclick();
    assert.deepEqual(shown(), ['', '/preview/a.png', '']);
    body.find('studio-swap')[0].onclick();
    assert.deepEqual(shown(), ['/preview/a.png', '', '']);

    // Taken back, then references one at a time, numbered, « n/3 » at the end of the line.
    slots()[0].find('studio-slot-remove')[0].onclick();
    await drop(2, 'b.png');
    await drop(3, 'c.png');
    assert.deepEqual(badges(), ['@1', '@2']);
    assert.equal(body.find('studio-references-count')[0].textContent, '2/3');
    assert.equal(slots().length, 5, 'start, end, two references and one empty slot');
    // @1 taken back: the next one becomes @1, no hole.
    body.find('studio-references')[0].find('studio-slot-remove')[0].onclick();
    assert.deepEqual(badges(), ['@1']);
    assert.equal(
      body.find('studio-references')[0].find('studio-slot')[0].children[0].children[0].src,
      '/preview/c.png',
    );
    assert.equal(body.find('studio-references-count')[0].textContent, '1/3');

    // Another model: its blocks say so for a moment (a light line); a start image only, the line
    // ends with the length, no « ⇄ ».
    model('w');
    const [start] = body.find('studio-input-block');
    assert.equal(body.find('studio-input-block').length, 1);
    assert.equal(start.attributes['aria-label'], 'Image de début');
    assert.match(start.className, /is-flash/);
    assert.deepEqual(body.find('studio-swap'), []);
    assert.equal(body.find('studio-span-time')[0].textContent, '10.04 S');
    // Back: the reference kept comes back with it.
    model('v');
    assert.deepEqual(badges(), ['@1']);
  } finally {
    restore();
  }
});

test('the screen: its format and length at the top left, no « i » (a click in the Sortie shows the details)', async () => {
  const video = {
      id: 'v',
      name: 'Clip',
      styled: true,
      limits: sizes,
      size: { width: 768, height: 448 },
      settings: [],
      seeded: true,
      stages: true,
      lengths: { seconds: [121 / 24, 193 / 24], standard: 121 / 24 },
      roles: {},
      loras: [{ id: 'grain', name: 'Grain', assistant: false, on: true, strength: { value: 0.8 } }],
    },
    image = {
      id: 'i',
      name: 'Image',
      styled: true,
      limits: sizes,
      size: { width: 1024, height: 1024 },
      settings: [],
      seeded: true,
      roles: {},
    },
    sound = {
      id: 's',
      name: 'Bruitages',
      roles: {},
      settings: [{ key: 'seconds', type: 'number', min: 1, max: 30, default: 10 }],
    },
    clip = {
      id: 'c',
      mediaType: 'video',
      prompt: 'un renard',
      workflowId: 'v',
      workflowName: 'Clip',
      parameters: {
        width: 512,
        height: 288,
        frames: 124,
        fps: 24,
        stage: 'draft',
        loras: [{ id: 'grain', strength: 0.8 }],
        styles: [{ name: 'sub\\light.safetensors', strength: 1 }],
      },
      outputs: [{ originalUrl: '/clip.mp4' }],
    };
  const { studio, body, restore, mode } = await studioPage(
    { create_image: [image], create_video: [video], create_audio: [sound] },
    {},
    { runs: [clip] },
  );
  try {
    const readout = () => body.find('studio-readout')[0].textContent;
    // The Studio opened on the mode of the last take, a clip (16/11). An image: its format; a sound:
    // its length; a clip: both (« BROUILLON » is in Détails now).
    assert.equal(body.dataset.mode, 'video');
    mode(0);
    assert.equal(readout(), '1:1');
    mode(2);
    assert.equal(readout(), '10.00 S');
    mode(1);
    assert.equal(readout(), '16:9 - 05.04 S');
    // No « i » on the screen, nothing it opened.
    studio.show(clip);
    assert.deepEqual(body.find('studio-details-go'), []);
    assert.deepEqual(body.find('studio-details'), []);
  } finally {
    restore();
  }
});

test('the floppy disk keeps the settings of the model, given back each time it is chosen; nothing « Fixe » is kept', async () => {
  const lengths = { seconds: [121 / 24, 193 / 24, 241 / 24], standard: 121 / 24 },
    free = {
      id: 'h',
      name: 'H3',
      styled: true,
      direct: true,
      seeded: true,
      limits: sizes,
      size: { width: 768, height: 448 },
      settings: [],
      lengths,
      roles: {},
      loras: [
        { id: 'msr', name: 'MSR', assistant: true, on: false, strength: { min: 0, max: 2, default: 1 } },
        { id: 'net', name: 'Net', assistant: false, on: true, strength: { value: 0.7 } },
      ],
    },
    // Length, size and seed fixed in Workflows: no bar, no seed, nothing of them kept.
    fixed = {
      id: 'f',
      name: 'Fixe',
      styled: true,
      direct: false,
      seeded: false,
      limits: sizes,
      size: { width: 768, height: 448 },
      settings: [],
      roles: {},
    };
  const posted = [];
  const { body, restore, mode } = await studioPage(
    { create_video: [free, fixed] },
    {
      'studio/preset': request => {
        posted.push(request);
        return { workflow: request.workflow, preset: { ...request.preset, savedAt: 'maintenant' } };
      },
    },
  );
  try {
    mode(1);
    const disk = () => body.find('studio-save')[0],
      duration = () => body.find('studio-bar').find(bar => bar.dataset.ai === 'duration'),
      model = id => {
        const pick = body.find('studio-model-pick')[0];
        pick.value = id;
        pick.onchange();
      };
    // In the Modèle block, its name for screen readers and in its tooltip; quiet at first.
    assert.equal(body.find('studio-set-model')[0].find('studio-save').length, 1);
    assert.equal(disk().dataset.state, 'still');
    assert.match(disk().attributes['aria-label'], /^Enregistrer ces réglages pour H3/);
    // A setting moved: a light pill.
    duration().value = '1';
    duration().oninput();
    assert.equal(disk().dataset.state, 'changed');
    // A seed and the LoRA left to the assistant, then saved: what is free, nothing else.
    body.find('studio-more-pill')[0].onclick();
    const seed = body.find('studio-seed')[0].children[1];
    seed.value = '42';
    seed.oninput();
    body.find('studio-lora-switch')[0].checked = true;
    body.find('studio-lora-switch')[0].onchange();
    await disk().onclick();
    await settle();
    const [first] = posted;
    assert.equal(first.workflow, 'h');
    assert.equal(first.preset.length, 193 / 24);
    assert.equal(first.preset.seed, '42');
    assert.equal(first.preset.format, '16:9');
    assert.deepEqual(first.preset.styles, []);
    assert.deepEqual(first.preset.loras, { msr: { on: true, strength: 1 } }, 'the LoRA fixed in Workflows is not kept');
    // Just saved: the check.
    assert.equal(disk().dataset.state, 'saved');
    assert.match(disk().attributes['aria-label'], /^Réglages enregistrés pour H3/);

    // Changed again, then another model: its own, nothing saved for it yet.
    duration().value = '2';
    duration().oninput();
    model('f');
    assert.equal(disk().dataset.state, 'still');
    await disk().onclick();
    await settle();
    assert.deepEqual(Object.keys(posted[1].preset), ['styles'], 'length, size and seed fixed: none of them kept');
    // Back to H3: its saved settings come back.
    model('h');
    assert.equal(duration().value, '1');
    assert.equal(duration().attributes['aria-valuetext'], '08.04 S');
    assert.equal(body.find('studio-seed')[0].children[1].value, '42');
    assert.equal(body.find('studio-lora-switch')[0].checked, true);
    assert.equal(disk().dataset.state, 'still');
  } finally {
    restore();
  }
});

test('the settings saved for a model come back the first time the Studio shows it', async () => {
  const video = {
    id: 'h',
    name: 'H3',
    styled: true,
    direct: true,
    seeded: true,
    limits: sizes,
    size: { width: 768, height: 448 },
    settings: [],
    lengths: { seconds: [121 / 24, 193 / 24, 241 / 24], standard: 121 / 24 },
    roles: {},
  };
  const { body, restore, mode } = await studioPage(
    { create_video: [video] },
    {},
    {
      presets: {
        h: { length: 241 / 24, seed: '7', styles: [{ name: 'b.safetensors', strength: 0.5 }], savedAt: 'hier' },
      },
    },
  );
  try {
    mode(1);
    const duration = body.find('studio-bar').find(bar => bar.dataset.ai === 'duration');
    assert.equal(duration.attributes['aria-valuetext'], '10.04 S');
    assert.equal(body.find('studio-seed')[0].children[1].value, '7');
    assert.equal(body.find('studio-lora-row').length, 1);
  } finally {
    restore();
  }
});

test('a model this computer cannot run is greyed in the list with its reason, and never generates', async () => {
  const reason = 'Krea2 demande une carte graphique NVIDIA : son pilote n’en voit aucune sur cet ordinateur.';
  const model = (id, more = {}) => ({
    id,
    name: id,
    roles: {},
    limits: sizes,
    direct: true,
    size: { width: 1024, height: 1024 },
    settings: [],
    seeded: true,
    ...more,
  });
  const routes = { 'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }) };
  const started = asked => asked.filter(([route]) => route === 'tools/action').length;
  // Another model can run: it is the one in hand, the other is greyed in the list, its reason under it.
  let studio = await studioPage({ create_image: [model('moss'), model('krea', { unavailable: reason })] }, routes);
  try {
    const [usable, greyed] = studio.body.find('studio-model-pick')[0].children;
    assert.equal(usable.disabled, undefined);
    assert.deepEqual([greyed.disabled, greyed.title], [true, reason]);
    assert.equal(studio.body.find('studio-model-note')[0].textContent, reason);
    // « Générer » waits for a prompt only (55), not for the model greyed in the list.
    assert.deepEqual(
      [studio.body.find('studio-go')[0].disabled, studio.body.find('studio-go')[0].title],
      [true, 'Écrivez un prompt pour générer'],
    );
    studio.prompt().value = 'un phare';
    studio.prompt().oninput();
    studio.studio.render();
    assert.equal(studio.body.find('studio-go')[0].disabled, false);
  } finally {
    studio.restore();
  }
  // No other model: it is shown all the same, « Générer » greyed and saying why.
  studio = await studioPage({ create_image: [model('krea', { unavailable: reason })] }, routes);
  try {
    const go = studio.body.find('studio-go')[0];
    assert.deepEqual([go.disabled, go.title], [true, reason]);
    assert.equal(studio.body.find('studio-model-note')[0].textContent, reason);
    // Asked all the same (Ctrl + Entrée, or the button reached otherwise): nothing starts, and
    // the reason is said.
    studio.prompt().value = 'un phare';
    studio.prompt().oninput();
    studio.page['studio-view'].onkeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
    await settle();
    await go.onclick();
    await settle();
    assert.equal(started(studio.asked), 0);
    assert.equal(studio.notices.at(-1), reason);
  } finally {
    studio.restore();
  }
});

test('Ctrl + Entrée generates from anywhere in the Studio, and the button says so in its tooltip', async () => {
  const image = {
    id: 'w',
    name: 'Image',
    roles: {},
    limits: sizes,
    direct: true,
    size: { width: 1024, height: 1024 },
    settings: [],
    seeded: true,
  };
  const studio = await studioPage(
    { create_image: [image] },
    {
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }),
    },
  );
  const { page, body, asked, pageKeys, restore } = studio;
  try {
    const key = (overrides = {}) => ({ key: 'Enter', ctrlKey: true, preventDefault() {}, ...overrides }),
      started = () => asked.filter(([route]) => route === 'tools/action').length;
    // The triangle and « Générer »; the keys in its tooltip, no more « Ctrl ↵ » in the button.
    const go = body.find('studio-go')[0];
    assert.equal(go.children[0].glyph, 'play');
    assert.equal(go.children[1].textContent, 'Générer');
    assert.equal(body.find('studio-go-key').length, 0);
    // Nothing typed, it is greyed and says why (55); a prompt typed, the keys are in its tooltip.
    assert.deepEqual([go.disabled, go.title], [true, 'Écrivez un prompt pour générer']);
    studio.prompt().value = 'un phare';
    studio.prompt().oninput();
    studio.studio.render();
    assert.match(body.find('studio-go')[0].title, /^Générer \((Ctrl|⌘)\+Entrée\)$/);
    studio.prompt().value = '';
    studio.prompt().oninput();
    // Nothing typed: a prompt is asked for, nothing starts.
    page['studio-view'].onkeydown(key());
    await settle();
    assert.equal(started(), 0);
    assert.match(body.find('studio-error')[0].textContent, /Écrivez un prompt/);
    studio.prompt().value = 'un phare';
    studio.prompt().oninput();
    // Entrée alone is a line in the prompt.
    page['studio-view'].onkeydown(key({ ctrlKey: false }));
    assert.equal(started(), 0);
    // The message box of the chat sends with Entrée: the key is not the Studio's there.
    page['studio-view'].onkeydown(key({ target: { id: 'prompt' } }));
    assert.equal(started(), 0);
    page['studio-view'].onkeydown(key());
    await settle();
    const [, sent] = asked.find(([route]) => route === 'tools/action');
    // What is typed is what is sent: no style line is added any more.
    assert.equal(sent.arguments.prompt, 'un phare');

    // After a click beside the fields the focus is on none: the key reaches the page itself, and
    // generates too, but only while the Studio is the view on screen.
    const onPage = () => pageKeys.forEach(listener => listener({ ...key(), target: document.body }));
    assert.equal(started(), 1);
    onPage();
    assert.equal(started(), 1, 'the Studio is not on screen');
    page['studio-view'].offsetParent = {};
    onPage();
    await settle();
    assert.equal(started(), 2);
    // A key pressed in a field of another view is not the Studio's.
    pageKeys.forEach(listener => listener({ ...key(), target: {} }));
    assert.equal(started(), 2);
  } finally {
    restore();
  }
});

test('« Agent », right of « Générer » in the Double verre, opens the chat as the band at the foot did', async () => {
  const image = {
    id: 'w',
    name: 'Image',
    roles: {},
    limits: sizes,
    direct: true,
    size: { width: 1024, height: 1024 },
    settings: [],
    seeded: true,
  };
  let opened = 0;
  const { body, restore } = await studioPage({ create_image: [image] }, {}, { openAgent: () => opened++ });
  try {
    const group = body.find('studio-go-group')[0],
      [agent] = body.find('studio-agent'),
      go = body.find('studio-go')[0];
    assert.equal(agent.id, 'agent-open');
    // The Double verre (studio-maquette.md): « ▶ Générer », a rule, the Agent.
    assert.deepEqual([group.children[0], group.children[2]], [go, agent], 'Générer then the Agent, in one group');
    assert.equal(agent.find('studio-agent-word')[0].textContent, 'Agent');
    // An icon, its word, its name for screen readers and in its tooltip.
    assert.equal(agent.attributes['aria-label'], 'Moodix AI · ouvrir le chat');
    assert.equal(agent.title, 'Moodix AI · ouvrir le chat');
    assert.equal(agent.attributes['aria-controls'], 'chat-panel');
    // No colour along its foot (moodix-design.md 7 bis 22), only the light of its work.
    assert.equal(agent.find('studio-agent-rule').length, 0);
    assert.equal(agent.find('studio-agent-light').length, 1);
    agent.onclick();
    assert.equal(opened, 1);
    // The Sortie: no colour along its foot any more.
    const output = body.find('is-output')[0];
    assert.equal(body.find('moodix-rule').length, 0);
    assert.notEqual(output.children.at(-1).className, 'moodix-rule studio-output-rule');
  } finally {
    restore();
  }
  // Nothing ready to make: the chat stays at hand all the same.
  const empty = await studioPage({ create_image: [] }, {}, { openAgent: () => opened++ });
  try {
    const [agent] = empty.body.find('studio-agent');
    assert.ok(agent, 'Agent shown with the message');
    agent.onclick();
    assert.equal(opened, 2);
  } finally {
    empty.restore();
  }
});

test('« Améliorer le prompt » rewrites what is typed, which can be taken back; three LoRAs at most', async () => {
  const image = {
    id: 'w',
    name: 'Image',
    styled: true,
    roles: {},
    limits: sizes,
    direct: true,
    size: { width: 1024, height: 1024 },
    settings: [],
    seeded: true,
  };
  const studio = await studioPage(
    { create_image: [image] },
    { 'studio/enrich': ({ prompt }) => ({ prompt: 'A lighthouse at dusk. (' + prompt + ')' }) },
  );
  const { body, asked, restore } = studio;
  try {
    const wand = () => body.find('studio-enrich-go')[0];
    assert.equal(wand().children.at(-1).textContent, 'Améliorer le prompt');
    // Fewer than three letters: the wand waits, and says why.
    assert.equal(wand().disabled, true);
    assert.equal(wand().title, 'Écrivez d’abord quelques mots');

    // Nothing typed: nothing is asked of the model.
    await wand().onclick();
    assert.equal(asked.filter(([route]) => route === 'studio/enrich').length, 0);
    assert.match(body.find('studio-error')[0].textContent, /quelques mots/);
    studio.prompt().value = 'un';
    studio.prompt().oninput();
    await wand().onclick();
    assert.equal(asked.filter(([route]) => route === 'studio/enrich').length, 0);

    studio.prompt().value = 'un phare';
    studio.prompt().oninput();
    // Ready: it says what it does, and its keys.
    studio.studio.render();
    assert.match(wand().title, /^Améliorer le prompt avec Moodix AI \((Ctrl|⌘)\+E\)$/);
    await body.find('studio-enrich-go')[0].onclick();
    assert.deepEqual(asked.find(([route]) => route === 'studio/enrich')[1], {
      prompt: 'un phare',
      verb: 'create_image',
    });
    assert.equal(studio.prompt().value, 'A lighthouse at dusk. (un phare)');
    // What was typed is one click away.
    const back = body.find('studio-enrich')[0].children.find(child => child.className === 'studio-link');
    back.onclick();
    assert.equal(studio.prompt().value, 'un phare');
    assert.equal(body.find('studio-enrich')[0].children.length, 1);

    // The seed is rare: under « ··· », a pill named for screen readers, closed at first.
    const [more] = body.find('studio-more-pill');
    assert.equal(more.attributes['aria-label'], 'Plus de réglages');
    assert.equal(body.find('studio-rare')[0].hidden, true);
    more.onclick();
    assert.equal(body.find('studio-rare')[0].hidden, false);
    assert.equal(body.find('studio-seed').length, 1);
    // The LoRAs in their own block: « LoRA · n / 3 », a line each, and no fourth.
    for (let added = 0; added < 3; added++) body.find('studio-lora-plus')[0].onclick();
    assert.equal(body.find('studio-lora-row').length, 3);
    assert.equal(body.find('studio-lora-count')[0].textContent, '· 3 / 3');
    assert.deepEqual(body.find('studio-lora-plus'), []);
    body.find('studio-lora-drop')[0].onclick();
    assert.equal(body.find('studio-lora-row').length, 2);
    assert.equal(body.find('studio-lora-plus').length, 1);
  } finally {
    restore();
  }
});

test('Ctrl+E improves the prompt from the Studio; an image pasted or dropped on its column goes to the first free slot', async () => {
  const video = {
    id: 'v',
    name: 'Clip',
    styled: true,
    limits: sizes,
    size: { width: 768, height: 448 },
    settings: [],
    seeded: true,
    exclusive: [['start_image', 'end_image'], ['reference']],
    roles: {
      start_image: { count: 1, media: ['image'] },
      end_image: { count: 1, media: ['image'] },
      reference: { count: 2, media: ['image'] },
    },
  };
  const studio = await studioPage(
    { create_video: [video], create_audio: [{ id: 's', name: 'Son', roles: {}, settings: [] }] },
    { 'studio/enrich': ({ prompt }) => ({ prompt: 'Better: ' + prompt }) },
  );
  const { page, body, asked, notices, restore, mode } = studio;
  try {
    mode(1);
    const improved = () => asked.filter(([route]) => route === 'studio/enrich').length,
      key = (overrides = {}) => ({ key: 'e', ctrlKey: true, preventDefault() {}, ...overrides });
    studio.prompt().value = 'un bateau';
    studio.prompt().oninput();
    // In the message box of the chat, Ctrl+E is not the Studio's.
    page['studio-view'].onkeydown(key({ target: { id: 'prompt' } }));
    await settle();
    assert.equal(improved(), 0);
    page['studio-view'].onkeydown(key());
    await settle();
    assert.equal(improved(), 1);
    assert.equal(studio.prompt().value, 'Better: un bateau');

    // Pasted, then dropped on the column: the first free slots, in their order.
    const write = body.find('studio-write')[0],
      file = name => ({ name, type: 'image/png' }),
      shown = () =>
        body
          .find('studio-slot')
          .map(tile => (tile.className.includes('is-filled') ? tile.children[0].children[0].src : ''));
    let stopped = 0;
    write.onpaste({ clipboardData: { files: [file('a.png')] }, preventDefault: () => stopped++ });
    await settle();
    assert.equal(stopped, 1, 'the image is not pasted as text');
    assert.deepEqual(shown(), ['/preview/a.png', '', '']);
    body.find('studio-write')[0].ondrop({ dataTransfer: { files: [file('b.png')] }, preventDefault() {} });
    await settle();
    // The references do not combine with a start image: the end takes it.
    assert.deepEqual(shown(), ['/preview/a.png', '/preview/b.png', '']);
    body.find('studio-write')[0].onpaste({ clipboardData: { files: [file('c.png')] }, preventDefault() {} });
    await settle();
    assert.equal(notices.at(-1), 'Toutes les cases d’images sont prises.');
    // Text pasted stays text.
    stopped = 0;
    body.find('studio-write')[0].onpaste({ clipboardData: { files: [] }, preventDefault: () => stopped++ });
    assert.equal(stopped, 0);

    // A sound: no wand, and Ctrl+E does nothing.
    mode(2);
    studio.prompt().value = 'pluie';
    studio.prompt().oninput();
    assert.deepEqual(body.find('studio-enrich-go'), []);
    page['studio-view'].onkeydown(key());
    await settle();
    assert.equal(improved(), 1);
  } finally {
    restore();
  }
});

test('the LoRAs of a model do not follow to a model of another family, and come back with theirs', async () => {
  const image = (id, name, family) => ({
    id,
    name,
    family,
    styled: true,
    roles: {},
    limits: sizes,
    direct: true,
    size: { width: 1024, height: 1024 },
    settings: [],
    seeded: true,
  });
  const studio = await studioPage(
    {
      create_image: [
        image('k', 'Krea 2', 'krea2'),
        image('k2', 'Krea 2 rétro', 'krea2'),
        image('m', 'MOSS Image', 'moss'),
      ],
    },
    {
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }),
    },
  );
  const { body, asked, restore } = studio;
  try {
    const model = to => {
        const control = body.find('studio-model-pick')[0];
        control.value = to;
        control.onchange();
      },
      generate = async () => {
        studio.prompt().value = 'une affiche';
        studio.prompt().oninput();
        await body.find('studio-go')[0].onclick();
        await settle();
        return asked.filter(([route]) => route === 'tools/action').at(-1)[1];
      };
    body.find('studio-lora-plus')[0].onclick();
    body.find('studio-lora-plus')[0].onclick();
    assert.equal(body.find('studio-lora-row').length, 2);

    // Another workflow of the same family keeps them.
    model('k2');
    assert.equal(body.find('studio-lora-row').length, 2);

    // MOSS Image: none of Krea 2's LoRAs is shown, and none is sent.
    model('m');
    assert.equal(body.find('studio-lora-row').length, 0);
    assert.equal(body.find('studio-lora-count')[0].textContent, '· 0 / 3');
    const sent = await generate();
    assert.equal(sent.arguments.workflow ?? 'm', 'm');
    assert.equal(sent.styles, undefined);

    // One of its own, then back to Krea 2: each family finds its own again.
    body.find('studio-lora-plus')[0].onclick();
    model('k');
    assert.equal(body.find('studio-lora-row').length, 2);
    assert.equal((await generate()).styles.length, 2);
    model('m');
    assert.equal(body.find('studio-lora-row').length, 1);
  } finally {
    restore();
  }
});

/** A video workflow with three lengths and a proposal of Moodix AI for it. */
function proposalOf({ prompt = 'Un renard se lève', frames = 121 } = {}) {
  const clip = {
    id: 'v',
    name: 'Clip',
    roles: { start_image: { count: 1, media: ['image'] } },
    limits: sizes,
    size: { width: 768, height: 448 },
    final: { width: 1344, height: 768 },
    stages: true,
    seeded: true,
    lengths: { seconds: [121 / 24, 193 / 24, 241 / 24], standard: 121 / 24 },
    settings: [],
  };
  const request = {
    requestId: 'q',
    approvalToken: 't',
    tool: 'create_video',
    mediaType: 'video',
    workflowName: 'Clip',
    resolution: { width: 768, height: 448 },
    call: { id: 'call', type: 'function', function: { name: 'create_video', arguments: '{}' } },
    plan: {
      prompt,
      stage: 'draft',
      parameters: { prompt, width: 768, height: 448, frames, fps: 24, seed: 7 },
      editable: {
        prompt: true,
        stages: ['draft', 'final'],
        parameters: [
          { key: 'frames', type: 'integer', value: frames, choices: [121, 193, 241] },
          { key: 'width', type: 'integer', value: 768 },
          { key: 'height', type: 'integer', value: 448 },
          { key: 'seed', type: 'integer', value: 7 },
        ],
        references: [],
      },
      references: [],
    },
  };
  return { clip, request };
}

/** A suite of tool calls recorded (tests/fixtures), replayed without a language model. */
async function recordedProposal() {
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile(new URL('./fixtures/moodix-ai-studio.json', import.meta.url), 'utf8'));
}
/** The Studio of the replay: LTX 2.5 after MiniMax H3 Omni, and the take 1 of the project. */
function replayStudio() {
  const ltx = {
      id: 'ltx',
      name: 'LTX 2.5',
      roles: {
        start_image: { count: 1, media: ['image'] },
        end_image: { count: 1, media: ['image'] },
        reference: { count: 2, media: ['image'] },
      },
      limits: sizes,
      size: { width: 768, height: 448 },
      stages: true,
      seeded: true,
      lengths: { seconds: [121 / 24, 145 / 24, 193 / 24], standard: 121 / 24 },
      settings: [],
    },
    minimax = { ...ltx, id: 'h3', name: 'MiniMax H3 Omni' },
    portrait = {
      id: 'd91877b3-e6e4-4cf8-ae95-49665e6aa1ae',
      prompt: 'Un portrait',
      outputs: [{ take: 1, thumbUrl: '/portrait.webp', originalUrl: '/portrait.png', width: 1024, height: 1024 }],
    };
  return { tools: { create_video: [minimax, ltx] }, runs: [portrait] };
}
const until = async (check, tries = 400) => {
  for (let at = 0; at < tries && !check(); at++) await new Promise(resolve => setTimeout(resolve, 2));
};

test('a recorded proposal replayed: the pointer does what Moodix AI proposes, in turn, and waits on « Générer »', async () => {
  const recorded = await recordedProposal(),
    { tools, runs } = replayStudio(),
    said = [];
  const studio = await studioPage(tools, {}, { runs, cursor: said, targets: true });
  const { body, asked, restore } = studio;
  try {
    const answer = studio.studio.propose(structuredClone(recorded.request), new AbortController().signal);
    await until(() => said.includes('attend votre accord'));
    // Each setting it changes, said as it is done (studio-maquette.md): the mode, the model, the
    // prompt written, the take carried to its case (16/11: no « Créations du projet » any more), the
    // format, the length; then « Générer ».
    assert.deepEqual(said, [
      'passe en Vidéo',
      'choisit LTX 2.5',
      'écrit le prompt',
      'pose la prise 1 en début',
      'passe en 9:16',
      'règle la durée',
      'attend votre accord',
    ]);
    assert.equal(body.dataset.mode, 'video');
    assert.equal(studio.prompt().value, recorded.request.plan.prompt);
    assert.equal(body.find('studio-slot')[0].children[0].children[0].src, '/portrait.webp');
    const duration = body.find('studio-bar').find(bar => bar.dataset.ai === 'duration');
    assert.equal(duration.attributes['aria-valuetext'], '06.04 S');
    // It stays there, « Refuser » beside it; nothing starts by itself.
    assert.equal(studio.page['ai-cursor'].classList.contains('is-visible'), true);
    assert.equal(body.find('studio-decline').length, 1);
    assert.equal(body.find('studio-shelf').length, 0);
    assert.equal(asked.filter(([route]) => route.startsWith('tools/')).length, 0);
    studio.studio.decline();
    assert.equal(await answer, 'deny');
  } finally {
    restore();
  }
});

test('while Moodix AI sets the Studio nothing in it answers the user and nothing stops it; on « Générer » all is theirs again', async () => {
  const recorded = await recordedProposal(),
    { tools, runs } = replayStudio(),
    said = [],
    locked = [];
  let view = null;
  // At each word of the pointer, whether the Studio was locked then (inert: the page gives it no
  // click, no key, no drop).
  Object.defineProperty(said, 'push', {
    value(label) {
      locked.push(view?.inert === true);
      return Array.prototype.push.call(this, label);
    },
  });
  const studio = await studioPage(tools, {}, { runs, cursor: said, targets: true });
  const { body, page, restore } = studio;
  view = page['studio-view'];
  const duration = () => body.find('studio-bar').find(bar => bar.dataset.ai === 'duration');
  try {
    const answer = studio.studio.propose(structuredClone(recorded.request), new AbortController().signal);
    await until(() => said.includes('écrit le prompt'));
    assert.equal(view.inert, true);
    // A touch that would reach it anyway changes nothing: the pointer goes on, to the end, and the
    // values are those of Moodix AI.
    const onDuration = { closest: () => ({ dataset: { ai: 'duration' } }) };
    view.listeners.pointerdown({ isTrusted: true, target: onDuration });
    view.listeners.input({ isTrusted: true, type: 'input', target: onDuration });
    await until(() => said.includes('attend votre accord') && view.inert === false);
    assert.deepEqual(said, [
      'passe en Vidéo',
      'choisit LTX 2.5',
      'écrit le prompt',
      'pose la prise 1 en début',
      'passe en 9:16',
      'règle la durée',
      'attend votre accord',
    ]);
    assert.equal(locked.length, said.length);
    assert.ok(locked.every(Boolean), 'locked from its first step to « Générer »');
    assert.equal(page['ai-cursor'].classList.contains('is-visible'), true);
    assert.equal(studio.prompt().value, recorded.request.plan.prompt);
    assert.equal(duration().attributes['aria-valuetext'], '06.04 S');
    // Resting on « Générer »: nothing is locked any more, the settings answer.
    assert.equal(view.inert, false);
    duration().value = '2';
    duration().oninput();
    assert.equal(duration().attributes['aria-valuetext'], '08.04 S');
    studio.studio.decline();
    assert.equal(await answer, 'deny');
    assert.equal(view.inert, false);
  } finally {
    restore();
  }
});

test('Moodix AI sets its proposal in the Studio and waits: « Générer » is the answer, with the user’s changes', async () => {
  const { clip, request } = proposalOf();
  const studio = await studioPage(
    { create_video: [clip] },
    { 'tools/revise': ({ edits }) => ({ requestId: 'q2', approvalToken: 't2', revised: edits }) },
  );
  const { body, asked, revealed, restore } = studio;
  try {
    assert.equal(studio.studio.accepts('create_video'), true);
    assert.equal(studio.studio.accepts('upscale'), false);
    const answer = studio.studio.propose(request, new AbortController().signal);
    await settle();
    // The Studio came on screen, in Vidéo, with what the pointer set.
    assert.equal(revealed.length, 1);
    assert.equal(body.dataset.mode, 'video');
    assert.equal(studio.prompt().value, 'Un renard se lève');
    // The lengths of the model on a bar, step by step: the one proposed, written as it is made.
    const duration = () => body.find('studio-bar').find(bar => bar.dataset.ai === 'duration');
    assert.equal(duration().value, '0');
    assert.equal(duration().attributes['aria-valuetext'], '05.04 S');
    assert.equal(studio.studio.proposing(), true);
    // Nothing starts by itself: the pointer stops on « Générer », beside a way to decline.
    assert.equal(asked.filter(([route]) => route.startsWith('tools/')).length, 0);
    assert.equal(body.find('studio-decline').length, 1);
    // The user lengthens it, then generates: the change goes first, then the answer.
    const length = duration();
    length.value = '1';
    length.oninput();
    assert.equal(length.attributes['aria-valuetext'], '08.04 S');
    await body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    assert.deepEqual(asked.find(([route]) => route === 'tools/revise')[1], {
      requestId: 'q',
      approvalToken: 't',
      edits: { frames: 193 },
    });
    // The proposal now is the revised one, and the generation is followed by the chat turn.
    assert.equal(request.requestId, 'q2');
    assert.equal(studio.studio.proposing(), false);
    assert.equal(studio.studio.busy(), true);
    studio.studio.follow('Génération…', 0.42);
    assert.equal(body.find('studio-progress')[0].hidden, false);
    await studio.studio.settled({ record: null, error: 'Mémoire insuffisante.' });
    assert.equal(studio.studio.busy(), false);
    assert.match(body.find('studio-error')[0].textContent, /Mémoire insuffisante/);
    // The seed drawn for the proposal was its own: a creation by hand draws again.
    assert.equal(body.find('studio-seed')[0].children[1].value, '');
  } finally {
    restore();
  }
});

test('a proposal left as it is goes as it is; declined, it is answered « deny »', async () => {
  const { clip, request } = proposalOf();
  const studio = await studioPage({ create_video: [clip] });
  const { body, asked, restore } = studio;
  try {
    let answer = studio.studio.propose(request, new AbortController().signal);
    await settle();
    await body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    assert.equal(asked.filter(([route]) => route === 'tools/revise').length, 0, 'nothing changed: nothing revised');
    await studio.studio.settled({ record: null });

    const second = proposalOf({ prompt: 'Un phare la nuit' });
    answer = studio.studio.propose(second.request, new AbortController().signal);
    await settle();
    assert.equal(studio.prompt().value, 'Un phare la nuit');
    body.find('studio-decline')[0].onclick();
    assert.equal(await answer, 'deny');
    assert.equal(studio.studio.proposing(), false);
    assert.deepEqual(body.find('studio-decline'), []);

    // A new message in the chat declines it too; a stopped turn takes it away.
    const third = proposalOf();
    answer = studio.studio.propose(third.request, new AbortController().signal);
    await settle();
    assert.equal(studio.studio.decline(), true);
    assert.equal(await answer, 'deny');
    const stopped = new AbortController();
    answer = studio.studio.propose(proposalOf().request, stopped.signal);
    await settle();
    stopped.abort();
    await assert.rejects(answer);
    assert.equal(studio.studio.proposing(), false);
  } finally {
    restore();
  }
});

test('the pointer only sets what the workflow leaves to the assistant', async () => {
  const { clip, request } = proposalOf({ frames: 193 });
  // « Fixe » in the workflow: the length is not the assistant's.
  request.plan.editable.parameters = request.plan.editable.parameters.filter(item => item.key !== 'frames');
  clip.lengths = null;
  const studio = await studioPage({ create_video: [clip] });
  const { body, restore } = studio;
  try {
    const answer = studio.studio.propose(request, new AbortController().signal);
    await settle();
    // No length to set: none is shown, none is sent.
    assert.deepEqual(
      body.find('studio-bar').filter(bar => bar.dataset.ai === 'duration'),
      [],
    );
    await body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
  } finally {
    restore();
  }
});

test('the Studio reads its tools once at a time, and its creations only when something changed', async () => {
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] };
  const { clip, request } = proposalOf();
  const studio = await studioPage({ create_image: [image], create_video: [clip] }, {}, { open: false });
  const { asked, restore } = studio;
  const tools = () => asked.filter(([route]) => route === 'studio').length,
    galleries = () =>
      asked.filter(([route]) => /^(project-)?gallery\//.test(route)).map(([route]) => route);
  try {
    // A proposal arrives as the Studio opens: one reading of the tools for both.
    const opening = studio.studio.open(),
      answer = studio.studio.propose(request, new AbortController().signal);
    await opening;
    await settle();
    assert.equal(tools(), 1);
    studio.studio.decline();
    await answer;
    // Its creations, without the copies kept for the model.
    assert.ok(galleries().length >= 1);
    assert.ok(galleries().every(route => /\?images=0(&|$)/.test(route)));
    // Going to the chat and back reads nothing again.
    const read = galleries().length;
    await studio.studio.open();
    await studio.studio.open();
    assert.equal(galleries().length, read);
    assert.equal(tools(), 1);
    // Something made from the chat: its creations are read again at the next opening.
    studio.studio.invalidate();
    await studio.studio.open();
    assert.equal(galleries().length, read + 1);
    // The settings closed: the tools too, in the background.
    studio.studio.invalidate({ tools: true });
    await studio.studio.open();
    await settle();
    assert.equal(tools(), 2);
  } finally {
    restore();
  }
});

test('drawn again, the Studio keeps the pictures of its Sortie and what its screen shows', async () => {
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] };
  const made = {
    id: 'r1',
    mediaType: 'image',
    prompt: 'un phare',
    outputs: [{ originalUrl: '/phare', thumbUrl: '/phare.jpg' }],
  };
  const { studio, body, restore } = await studioPage({ create_image: [image] }, {}, { runs: [made] });
  try {
    const picture = () => body.find('studio-item-pick')[0].children[0];
    const first = picture();
    assert.equal(first.src, '/phare.jpg');
    studio.render();
    assert.equal(picture(), first, 'the same picture: nothing loaded again');
    studio.show(made);
    const [shown] = body.find('studio-frame-result');
    studio.render();
    assert.equal(body.find('studio-frame-result')[0], shown);
  } finally {
    restore();
  }
});

test('the LoRAs chosen in a workflow are listed for the Studio, named by their file, those switched off left out', async () => {
  const { readFile } = await import('node:fs/promises');
  const { ToolCatalog } = await import('../lib/tool-catalog.mjs');
  const krea = JSON.parse(
    await readFile(new URL('../runner/workflows/fefb88eb-8311-4409-b636-6efbb42e952c.json', import.meta.url), 'utf8'),
  );
  const loras = [
    {
      id: 'grain',
      asset: 'a1',
      description: 'Grain de film',
      enabled: { policy: 'model', default: false },
      strength: { policy: 'model', min: 0, max: 1.5, default: 0.8 },
    },
    {
      id: 'net',
      asset: 'a2',
      description: '',
      enabled: { policy: 'fixed', value: true },
      strength: { policy: 'fixed', value: 1 },
    },
    {
      id: 'old',
      asset: 'a3',
      description: 'Hors service',
      enabled: { policy: 'off' },
      strength: { policy: 'fixed', value: 1 },
    },
  ];
  const tools = new ToolCatalog({
    list: async () => [{ ...krea, loras, ready: true }],
    // The registry names its files; a LoRA without one is named by its description.
    assets: {
      list: async () => [
        { id: 'a1', path: 'D:/loras/film_grain.safetensors' },
        { id: 'a2', name: 'net.safetensors', path: 'D:/x/autre.safetensors' },
      ],
    },
  });
  const [workflow] = (await tools.studio()).create_image;
  assert.deepEqual(workflow.loras, [
    {
      id: 'grain',
      name: 'film_grain',
      description: 'Grain de film',
      assistant: true,
      on: false,
      strength: { min: 0, max: 1.5, default: 0.8 },
    },
    { id: 'net', name: 'net', description: '', assistant: false, on: true, strength: { value: 1 } },
  ]);
});

/** A workflow that brings two LoRAs: one left to the assistant (off by default), one always on. */
const withLoras = workflow => ({
  ...workflow,
  loras: [
    {
      id: 'grain',
      name: 'film_grain',
      description: 'Grain de film',
      assistant: true,
      on: false,
      strength: { min: 0, max: 1.5, default: 0.8 },
    },
    { id: 'net', name: 'net', description: '', assistant: false, on: true, strength: { value: 1 } },
  ],
});

test('the LoRAs of the workflow show in the Studio: those of the assistant are switched there and go with the creation', async () => {
  const workflow = withLoras({
    id: 'w',
    name: 'Krea 2',
    family: 'krea2',
    roles: {},
    limits: sizes,
    direct: true,
    size: { width: 1024, height: 1024 },
    settings: [],
  });
  const page = await studioPage(
    { create_image: [workflow] },
    {
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => ({ id: 'j', state: 'error', error: 'arrêt' }),
    },
  );
  const { body, asked, restore } = page;
  try {
    // In the LoRA block, first, one line each, a padlock in place of ×.
    const rows = body.find('studio-lora-row');
    assert.equal(rows.length, 2);
    assert.match(rows[0].className, /is-off/, 'off by default, as the workflow says');
    assert.equal(rows[0].find('ai-mark').length, 1, 'the tile of Moodix AI: the assistant may switch it');
    assert.equal(rows[1].find('studio-lora-lock').length, 1);
    // A switch only for the one left to the assistant; « Activé » in Workflows is always applied,
    // its strength fixed there: its bar greyed.
    assert.equal(body.find('studio-lora-switch').length, 1);
    assert.equal(rows[1].find('studio-bar')[0].disabled, true);
    const [grain] = body.find('studio-lora-switch');
    grain.checked = true;
    grain.onchange();
    page.prompt().value = 'un renard';
    page.prompt().oninput();
    await body.find('studio-go')[0].onclick();
    const [, action] = asked.find(([route]) => route === 'tools/action');
    // As the model would give it; the LoRA fixed in the workflow is not the creation's to set.
    assert.deepEqual(action.arguments.loras, { grain: { enabled: true, strength: 0.8 } });
  } finally {
    restore();
  }
});

test('a proposal of Moodix AI switches the LoRAs of the workflow as it has them; changed here, they go with « Générer »', async () => {
  const { clip, request } = proposalOf();
  request.plan.loras = [
    { id: 'grain', strength: 1.2 },
    { id: 'net', strength: 1 },
  ];
  const studio = await studioPage(
    { create_video: [withLoras(clip)] },
    { 'tools/revise': ({ edits }) => ({ requestId: 'q2', approvalToken: 't2', revised: edits }) },
  );
  const { body, asked, restore } = studio;
  try {
    const answer = studio.studio.propose(request, new AbortController().signal);
    await settle();
    const [grain] = body.find('studio-lora-switch');
    assert.equal(grain.checked, true, 'on, as Moodix AI has it');
    assert.equal(body.find('studio-lora-row')[0].find('studio-bar-value')[0].textContent, '1,20');
    // The user switches it off before generating: the change goes with the answer.
    grain.checked = false;
    grain.onchange();
    await body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    assert.deepEqual(asked.find(([route]) => route === 'tools/revise')[1].edits, {
      loras: { grain: { enabled: false } },
    });
  } finally {
    restore();
  }
});

test('a replacement proposed in the chat is set by the pointer: the model, the video, the character, who is who', async () => {
  const scail = {
      id: 's',
      name: 'SCAIL-2',
      verb: 'replace_character',
      follows: true,
      seeded: true,
      roles: {
        source: { count: 1, media: ['video'], many: false, required: true },
        reference: { count: 1, media: ['image'], many: false, required: true },
      },
      settings: [
        { key: 'subject', type: 'string', maxLength: 200, default: 'person' },
        { key: 'reference_subject', type: 'string', maxLength: 200, default: 'person' },
      ],
    },
    clip = { id: 'v', name: 'Clip', verb: 'create_video', limits: sizes, size: { width: 768, height: 448 }, settings: [], roles: {} },
    runs = [
      {
        id: 'penguin',
        mediaType: 'video',
        prompt: 'un pingouin vole',
        outputs: [{ originalUrl: '/penguin.mp4', thumbUrl: '/penguin.jpg', width: 672, height: 672 }],
      },
      { id: 'player', prompt: 'un joueur', outputs: [{ originalUrl: '/player.png', thumbUrl: '/player.jpg' }] },
    ];
  const prompt = 'A volleyball player flies over the ice.';
  const request = {
    requestId: 'q',
    approvalToken: 't',
    tool: 'replace_character',
    mediaType: 'video',
    autoAllow: true,
    workflowName: 'SCAIL-2',
    call: { id: 'call', type: 'function', function: { name: 'replace_character', arguments: '{}' } },
    plan: {
      prompt,
      parameters: { prompt, width: 672, height: 672, frames: 121, fps: 24, seed: 3, subject: 'penguin', reference_subject: 'man' },
      editable: {
        prompt: true,
        parameters: [
          { key: 'subject', type: 'string', value: 'penguin' },
          { key: 'reference_subject', type: 'string', value: 'man' },
          { key: 'seed', type: 'integer', value: 3 },
          { key: 'width', type: 'integer', value: 672, locked: 'La vidéo prend la forme de celle qu’elle suit.' },
        ],
        references: [[], []],
      },
      // The slots' own roles, and the roles the verb gives them.
      references: [
        { input: 'video', role: 'driving_video', as: 'source', output_id: 'penguin', roleLabel: 'Vidéo à suivre' },
        { input: 'character', role: 'reference_image', as: 'reference', output_id: 'player', roleLabel: 'Personnage' },
      ],
    },
  };
  const studio = await studioPage({ create_video: [clip], replace_character: [scail] }, {}, { runs });
  const { body, restore } = studio;
  try {
    assert.equal(studio.studio.accepts('replace_character'), true);
    const answer = studio.studio.propose(request, new AbortController().signal);
    // Allowed in the settings: the pointer sets it, then starts it.
    assert.equal(await answer, 'once');
    assert.equal(body.dataset.mode, 'video');
    const pick = body.find('studio-model-pick')[0];
    assert.equal(pick.value, 's');
    // The video in its slot, the character in theirs, each with its picture.
    const tiles = body.find('studio-slot');
    assert.deepEqual(
      tiles.map(tile => tile.children[0].children[0]?.src),
      ['/penguin.jpg', '/player.jpg'],
    );
    assert.deepEqual(
      body.find('studio-who')[0].children.map(field => field.children[1].value),
      ['penguin', 'man'],
    );
    assert.equal(studio.prompt().value, prompt);
    // The screen has the shape of the video followed.
    assert.equal(body.find('studio-readout')[0]?.textContent ?? '1:1', '1:1');
  } finally {
    restore();
  }
});

test('the character Moodix AI made is checked: OK keeps it, « Autre image » has another made, « Annuler » stops', async () => {
  const krea = {
      id: 'k',
      name: 'Krea 2',
      verb: 'create_image',
      direct: true,
      limits: sizes,
      size: { width: 1024, height: 1024 },
      settings: [],
      roles: {},
    },
    runs = [{ id: 'made', prompt: 'A full-length photo of a player', outputs: [{ originalUrl: '/made.png', thumbUrl: '/made.jpg' }] }];
  const studio = await studioPage({ create_image: [krea] }, {}, { runs });
  const { body, revealed, restore } = studio;
  try {
    // The image of a character for a video of 1280 x 720: its format, about as many points.
    assert.deepEqual(studio.studio.imageSize({ width: 1280, height: 720 }), { width: 1344, height: 768 });
    assert.equal(studio.studio.imageSize(null), null);
    let check = studio.studio.checkCharacter(runs[0], new AbortController().signal);
    await settle();
    assert.equal(body.dataset.mode, 'image');
    assert.ok(revealed.length >= 1, 'the Studio comes on screen');
    assert.equal(studio.studio.proposing(), true);
    assert.equal(body.find('studio-check-question')[0].textContent, 'Ce personnage vous convient ?');
    assert.equal(body.find('studio-go-label')[0].textContent, 'OK');
    // The question on a line of its own, above its three answers.
    assert.match(body.find('studio-go-group')[0].className, /is-checking/);
    assert.deepEqual(
      body.find('studio-go-group')[0].children.map(child => child.className),
      ['studio-check-question', 'secondary studio-decline', 'secondary studio-again', 'primary studio-go'],
    );
    // The prompt of the screen, changed or not, is the one of the next image.
    studio.prompt().value = 'A full-length photo of a player in red';
    studio.prompt().oninput();
    body.find('studio-again')[0].onclick();
    assert.deepEqual(await check, { decision: 'again', prompt: 'A full-length photo of a player in red' });
    assert.equal(body.find('studio-check-question').length, 0);
    check = studio.studio.checkCharacter(runs[0], new AbortController().signal);
    await settle();
    await body.find('studio-go')[0].onclick();
    assert.equal((await check).decision, 'ok');
    check = studio.studio.checkCharacter(runs[0], new AbortController().signal);
    await settle();
    body.find('studio-decline')[0].onclick();
    assert.equal((await check).decision, 'cancel');
    // A new message in the chat cancels it too; a stopped turn stops it.
    check = studio.studio.checkCharacter(runs[0], new AbortController().signal);
    assert.equal(studio.studio.decline(), true);
    assert.equal((await check).decision, 'cancel');
    const stopped = new AbortController();
    check = studio.studio.checkCharacter(runs[0], stopped.signal);
    stopped.abort();
    await assert.rejects(check);
    assert.equal(studio.studio.proposing(), false);
  } finally {
    restore();
  }
});

test('a replacement whose character Moodix AI just made: the pointer has its prompt written from the video and that image', async () => {
  const scail = {
      id: 's',
      name: 'SCAIL-2',
      verb: 'replace_character',
      follows: true,
      seeded: true,
      roles: {
        source: { count: 1, media: ['video'], many: false, required: true },
        reference: { count: 1, media: ['image'], many: false, required: true },
      },
      settings: [
        { key: 'subject', type: 'string', maxLength: 200, default: 'person' },
        { key: 'reference_subject', type: 'string', maxLength: 200, default: 'person' },
      ],
    },
    runs = [
      {
        id: 'penguin',
        mediaType: 'video',
        prompt: 'un pingouin vole',
        outputs: [{ originalUrl: '/penguin.mp4', thumbUrl: '/penguin.jpg', width: 672, height: 672 }],
      },
      { id: 'player', prompt: 'une joueuse', outputs: [{ originalUrl: '/player.png', thumbUrl: '/player.jpg' }] },
    ];
  const drafted = 'A volleyball player takes the place of the penguin.',
    written =
      'A young woman in a navy volleyball jersey and black shorts flies over snowy peaks, arms spread wide, ' +
      'under a pale winter sky.';
  const proposal = () => ({
    requestId: 'q',
    approvalToken: 't',
    tool: 'replace_character',
    mediaType: 'video',
    autoAllow: true,
    workflowName: 'SCAIL-2',
    call: { id: 'call', type: 'function', function: { name: 'replace_character', arguments: '{}' } },
    plan: {
      prompt: drafted,
      parameters: { prompt: drafted, width: 672, height: 672, frames: 121, fps: 24, seed: 3 },
      editable: { prompt: true, parameters: [{ key: 'seed', type: 'integer', value: 3 }], references: [[], []] },
      references: [
        { input: 'video', role: 'driving_video', as: 'source', output_id: 'penguin', roleLabel: 'Vidéo à suivre' },
        { input: 'character', role: 'reference_image', as: 'reference', output_id: 'player', roleLabel: 'Personnage' },
      ],
    },
    // Set by the page for a character it has just made: what the user asked.
    scene: { asked: 'remplace le pingouin par une joueuse de volley' },
  });
  let studio = await studioPage(
    { replace_character: [scail] },
    {
      'studio/enrich': () => ({ prompt: written, seen: true }),
      'tools/revise': ({ edits }) => ({ requestId: 'q2', approvalToken: 't2', revised: edits }),
    },
    { runs },
  );
  try {
    assert.equal(await studio.studio.propose(proposal(), new AbortController().signal), 'once');
    // The chat model sees the video and the character where they were made, with what the user
    // asked and the prompt of Moodix AI as a draft.
    assert.deepEqual(studio.asked.find(([route]) => route === 'studio/enrich')[1], {
      prompt: 'remplace le pingouin par une joueuse de volley',
      draft: drafted,
      verb: 'replace_character',
      source: { output: 'penguin' },
      reference: { output: 'player' },
      conversationId: 'c1',
    });
    assert.equal(studio.prompt().value, written);
    // What it wrote is what is made.
    assert.deepEqual(studio.asked.find(([route]) => route === 'tools/revise')[1].edits, { prompt: written });
  } finally {
    studio.restore();
  }
  // The chat model cannot write it: the prompt of Moodix AI is made, and the Studio says why.
  studio = await studioPage(
    { replace_character: [scail] },
    {
      'studio/enrich': () => {
        throw Error('Ce modèle de chat ne voit pas les images.');
      },
    },
    { runs },
  );
  try {
    assert.equal(await studio.studio.propose(proposal(), new AbortController().signal), 'once');
    assert.equal(studio.notices.at(-1), 'Prompt de Moodix AI gardé : Ce modèle de chat ne voit pas les images.');
    assert.equal(studio.prompt().value, drafted);
    assert.equal(studio.asked.filter(([route]) => route === 'tools/revise').length, 0);
  } finally {
    studio.restore();
  }
  // A proposal of the chat itself (its own image given): its prompt, already written, is not
  // written again.
  studio = await studioPage({ replace_character: [scail] }, {}, { runs });
  try {
    const { scene, ...given } = proposal();
    assert.equal(await studio.studio.propose(given, new AbortController().signal), 'once');
    assert.equal(studio.asked.filter(([route]) => route === 'studio/enrich').length, 0);
  } finally {
    studio.restore();
  }
});

test('the screen is the conversation’s, the Sortie the project’s: a new conversation shows the takes of its project below, none above', async () => {
  const image = { id: 'w', name: 'Image', roles: { source: { count: 1, media: ['image'] } }, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] },
    taken = { id: 'a', conversationId: 'c1', prompt: 'un phare', outputs: [{ originalUrl: '/a.png', thumbUrl: '/a.jpg', take: 3 }] },
    elsewhere = { id: 'b', conversationId: 'c2', prompt: 'une falaise', outputs: [{ originalUrl: '/b.png', thumbUrl: '/b.jpg', take: 4 }] },
    inProject = { p1: [elsewhere, taken], p2: [] };
  let conversation = 'c1',
    project = 'p1';
  const page = await studioPage({ create_image: [image] }, {}, { runs: [], conversation: () => conversation, project: () => project });
  const { body, studio, restore, runs } = page;
  const items = () => body.find('studio-item').map(tile => tile.dataset.id),
    onScreen = () => body.find('studio-frame-result')[0]?.src ?? null,
    go = async (to, into = project) => {
      conversation = to;
      project = into;
      runs.splice(0, runs.length, ...inProject[into]);
      studio.conversationChanged();
      await settle();
    };
  try {
    await go('c1');
    // Below, every take of the project, the newest at the left; above, the one of this conversation.
    assert.deepEqual(items(), ['b', 'a']);
    assert.equal(onScreen(), '/a.png');
    // A new conversation of the project (no identifier yet): the same takes below, the screen empty.
    await go(null);
    assert.deepEqual(items(), ['b', 'a']);
    assert.equal(body.find('studio-frame')[0].className.includes('is-empty'), true);
    assert.equal(body.find('studio-blank-title')[0].textContent, 'Votre première prise apparaîtra ici.');
    // Another conversation of the project: its own take above, the same Sortie.
    await go('c2');
    assert.deepEqual(items(), ['b', 'a']);
    assert.equal(onScreen(), '/b.png');
    // Another project: its own takes (none), the Studio empty (etats-maquette.md, 55).
    await go('c9', 'p2');
    assert.deepEqual(items(), []);
    assert.equal(body.find('studio-frame')[0].className.includes('is-empty'), true);
  } finally {
    restore();
  }
});

test('a conversation opened sets the Studio as its last take was made: model, prompt, format, settings, LoRAs, inputs; a seed only if it was named', async () => {
  const krea = {
      id: 'k',
      name: 'Krea 2',
      family: 'krea2',
      seeded: true,
      direct: true,
      styled: true,
      roles: { source: { count: 1, media: ['image'] }, reference: { count: 2, media: ['image'], many: true } },
      inputs: { source_image: 'source', reference_image: 'reference' },
      limits: sizes,
      size: { width: 1024, height: 1024 },
      settings: [{ key: 'steps', type: 'number', min: 1, max: 50, default: 8 }],
      loras: [{ id: 'detail', name: 'Détail', on: false, assistant: true, strength: { min: 0, max: 2, default: 1 } }],
    },
    moss = { id: 'm', name: 'MOSS Image', family: 'moss', seeded: true, roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] },
    made = (id, conversationId, prompt, parameters, more = {}) => ({
      id,
      conversationId,
      workflowId: 'k',
      prompt,
      parameters: { width: 1024, height: 1024, seed: 111, ...parameters },
      outputs: [{ originalUrl: `/${id}.png`, thumbUrl: `/${id}.jpg` }],
      ...more,
    }),
    // The newest first, as the gallery lists them.
    all = [
      // Made from an image of the conversation, a reference of the project that is gone, and a take deleted.
      made('wide', 'c2', 'une plage en hiver', {
        width: 1344,
        height: 768,
        steps: 12,
        seed: 4242,
        seed_given: true,
        loras: [{ id: 'detail', strength: 1.5 }],
        styles: [{ name: 'a.safetensors', strength: 0.7 }, { name: 'gone.safetensors', strength: 1 }],
        references: [
          { input: 'edit', role: 'source_image', output_id: 'first' },
          { input: 'subject-1', role: 'reference_image', resource_id: 'kept' },
          { input: 'subject-2', role: 'reference_image', resource_id: 'erased' },
        ],
      }),
      made('first', 'c2', 'une plage', {}),
      // An enlargement, made by no model of the mode: the take before it gives the settings.
      made('large', 'c1', '', { width: 2048, height: 2048 }, { workflowId: 'upscaler' }),
      made('tall', 'c1', 'un phare la nuit', { width: 768, height: 1344, steps: 20 }),
    ];
  let conversation = 'c1';
  const page = await studioPage(
    { create_image: [moss, krea] },
    {
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }),
    },
    {
      runs: all,
      conversation: () => conversation,
      project: () => 'p1',
      resource: id => (id === 'kept' ? { id, label: '#ref2', name: 'visage.png', previewUrl: '/preview/kept', width: 800, height: 600 } : null),
    },
  );
  const { body, studio, asked, restore } = page;
  const slots = () => body.find('studio-slot').map(tile => tile.children[0].children[0]?.src ?? null),
    sent = async () => {
      await body.find('studio-go')[0].onclick();
      await settle();
      return asked.findLast(([route]) => route === 'tools/action')[1].arguments;
    };
  try {
    // « c1 »: on the screen its newest take (the enlargement); the settings of the last one a model made.
    assert.equal(body.find('studio-frame-result')[0].src, '/large.png');
    assert.equal(page.prompt().value, 'un phare la nuit');
    let args = await sent();
    assert.equal(args.workflow, 'k', 'its model, not the first of the list');
    assert.deepEqual([args.width, args.height, args.steps], [768, 1344, 20]);
    assert.equal(args.seed, undefined, 'its seed was drawn: another is drawn');
    assert.equal(args.source, undefined);
    // What the user writes there stays, there.
    page.prompt().value = 'un phare au matin';
    page.prompt().oninput();
    // « c2 »: the settings of its last take, its inputs in their cases; the reference that is gone
    // leaves its case empty, said in the Studio.
    conversation = 'c2';
    studio.conversationChanged();
    await settle();
    assert.equal(page.prompt().value, 'une plage en hiver');
    assert.deepEqual(slots(), ['/first.jpg', '/preview/kept', null]);
    assert.equal(body.find('studio-error')[0].textContent, 'Une image utilisée pour la dernière prise n’existe plus : sa case est restée vide.');
    args = await sent();
    assert.deepEqual([args.width, args.height, args.steps, args.seed], [1344, 768, 12, 4242], 'the seed the user had named');
    assert.deepEqual(args.source, { output: 'first' });
    assert.deepEqual(args.reference, [{ resource: 'kept' }]);
    assert.deepEqual(args.loras, { detail: { enabled: true, strength: 1.5 } });
    // The LoRA of the user that is still in its folder, not the one that left it.
    assert.deepEqual(asked.findLast(([route]) => route === 'tools/action')[1].styles, [{ name: 'a.safetensors', strength: 0.7 }]);
    // Back in « c1 »: as it was left (no take made in it since), not the settings of « c2 ».
    conversation = 'c1';
    studio.conversationChanged();
    await settle();
    assert.equal(page.prompt().value, 'un phare au matin');
    args = await sent();
    assert.deepEqual([args.width, args.height, args.steps, args.seed], [768, 1344, 20, undefined]);
    assert.equal(args.loras?.detail?.enabled ?? false, false);
  } finally {
    restore();
  }
});

test('a take made from the chat since the Studio was last seen sets it again; one it made itself does not', async () => {
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] },
    take = (id, prompt) => ({ id, conversationId: 'c1', workflowId: 'w', prompt, parameters: { width: 1024, height: 1024 }, outputs: [{ originalUrl: `/${id}.png`, thumbUrl: `/${id}.jpg` }] });
  const page = await studioPage(
    { create_image: [image] },
    {
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => ({ id: 'j', state: 'done', record: { id: 'b' } }),
    },
    { runs: [take('a', 'un renard')], project: () => 'p1' },
  );
  const { body, studio, runs, restore } = page;
  try {
    assert.equal(page.prompt().value, 'un renard');
    // Made here, with another prompt: the Studio keeps what the user goes on writing.
    page.prompt().value = 'un renard dans la neige';
    page.prompt().oninput();
    runs.unshift(take('b', 'un renard dans la neige'));
    await body.find('studio-go')[0].onclick();
    await settle();
    page.prompt().value = 'un renard qui court';
    page.prompt().oninput();
    await studio.open();
    assert.equal(page.prompt().value, 'un renard qui court');
    // Made from the chat meanwhile: the Studio takes its settings when it comes back on screen.
    runs.unshift(take('c', 'un lièvre'));
    studio.invalidate();
    await studio.open();
    assert.equal(page.prompt().value, 'un lièvre');
    assert.equal(body.find('studio-frame-result')[0].src, '/c.png');
  } finally {
    restore();
  }
});

test('the Sortie is the project’s: the creations of its other conversations dragged into a slot become inputs', async () => {
  const scail = {
      id: 's',
      name: 'SCAIL-2',
      verb: 'replace_character',
      follows: true,
      seeded: true,
      roles: {
        source: { count: 1, media: ['video'], many: false, required: true },
        reference: { count: 1, media: ['image'], many: false, required: true },
      },
      settings: [],
    },
    runs = [
      // Made in another conversation of the project.
      {
        id: 'clip',
        conversationId: 'other',
        mediaType: 'video',
        prompt: 'une fille cueille une pomme',
        outputs: [{ originalUrl: '/clip.mp4', thumbUrl: '/clip.jpg', width: 896, height: 512 }],
      },
      { id: 'face', conversationId: 'c1', prompt: 'un joueur', outputs: [{ originalUrl: '/face.png', thumbUrl: '/face.jpg' }] },
    ];
  const page = await studioPage(
    { replace_character: [scail] },
    {
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }),
    },
    { runs, project: () => 'p1' },
  );
  const { body, asked, notices, restore } = page;
  try {
    // Read for the whole project, with the open conversation.
    assert.ok(asked.some(([route]) => route === 'project-gallery/p1?images=0&conversation=c1'));
    page.mode(1);
    const items = () => body.find('studio-item'),
      slots = () => body.find('studio-slot'),
      event = { preventDefault() {}, stopPropagation() {}, dataTransfer: { files: [], setData() {} } },
      carry = (item, slot) => {
        items()[item].find('studio-item-pick')[0].ondragstart(event);
        slots()[slot].ondrop(event);
      };
    // The whole project (16/11: the takes are shared in it): the clip of another conversation and
    // the image of this one.
    assert.equal(items().length, 2);
    // An image is not the video to follow; the clip is.
    carry(1, 0);
    assert.match(notices.at(-1), /attend une vidéo/);
    assert.doesNotMatch(slots()[0].className, /is-filled/);
    carry(0, 0);
    carry(1, 1);
    assert.deepEqual(
      slots().map(tile => tile.children[0].children[0]?.src),
      ['/clip.jpg', '/face.jpg'],
    );
    page.prompt().value = 'A young man picks an apple.';
    page.prompt().oninput();
    await body.find('studio-go')[0].onclick();
    await settle();
    // The clip keeps its conversation: the server finds it there.
    const [, action] = asked.findLast(([route]) => route === 'tools/action');
    assert.deepEqual(action.arguments.source, { output: 'clip', conversation: 'other' });
    assert.deepEqual(action.arguments.reference, { output: 'face' });
  } finally {
    restore();
  }
});

test('a click on a slot, empty or filled, opens the files of the computer: no « Créations du projet » in the Studio', async () => {
  const image = {
      id: 'w',
      name: 'Image',
      roles: { source: { count: 1, media: ['image'], many: false } },
      limits: sizes,
      size: { width: 1024, height: 1024 },
      settings: [],
    },
    runs = [{ id: 'face', conversationId: 'c1', prompt: 'un joueur', outputs: [{ originalUrl: '/face.png', thumbUrl: '/face.jpg' }] }];
  const page = await studioPage({ create_image: [image] }, {}, { runs, project: () => 'p1' });
  const { body, restore } = page;
  try {
    const picker = page.page['studio-view'].children.find(child => child.tag === 'input'),
      slot = () => body.find('studio-slot')[0];
    assert.equal(picker.clicks ?? 0, 0);
    slot().find('studio-slot-pick')[0].onclick();
    assert.equal(picker.clicks, 1, 'the files of the computer, at once');
    assert.equal(picker.accept, 'image/png,image/jpeg,image/webp');
    assert.equal(body.find('studio-shelf').length, 0);
    assert.equal(body.find('studio-input-block').length, 1, 'nothing opens under the inputs');
    // The file chosen fills the case; a click on it again: another file.
    picker.files = [{ name: 'visage.png', type: 'image/png' }];
    await picker.onchange();
    await settle();
    assert.match(slot().className, /is-filled/);
    slot().find('studio-slot-pick')[0].onclick();
    assert.equal(picker.clicks, 2);
  } finally {
    restore();
  }
});

test('on a take of the Sortie, « Prolonger » and « Animer » wear the pictos of the bar of the screen', async () => {
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] },
    clip = { id: 'v', name: 'Clip', roles: { start_image: { count: 1, media: ['image'] } }, limits: sizes, size: { width: 768, height: 448 }, settings: [] },
    runs = [
      { id: 'c1', mediaType: 'video', prompt: 'un clip', outputs: [{ originalUrl: '/c1.mp4', thumbUrl: '/c1.jpg' }] },
      { id: 'p1', prompt: 'une image', outputs: [{ originalUrl: '/p1.png' }] },
    ];
  const page = await studioPage({ create_image: [image], create_video: [clip] }, {}, { runs });
  try {
    const main = id => page.body.find('studio-item').find(tile => tile.dataset.id === id).find('studio-item-main')[0];
    assert.equal(main('c1').children[0].glyph, 'act-extend');
    assert.equal(main('c1').attributes['aria-label'], 'Prolonger · Clip #2');
    assert.equal(main('p1').children[0].glyph, 'act-animate');
  } finally {
    page.restore();
  }
  const css = (await (await import('node:fs/promises')).readFile(new URL('../public/moodix.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  // A rounded square, smaller than on the bar, 6 px from the bottom of the picture (not of the tile).
  assert.match(css, /#studio-view \.studio-item-main,\n#studio-view \.studio-item-del \{\n  width: 26px;\n  height: 26px;\n  border: 1px solid rgba\(238, 232, 222, 0\.14\);\n  border-radius: 8px;/);
  assert.match(css, /#studio-view \.studio-item-main \{\n  top: calc\(var\(--strip-h, 96px\) - 32px\);\n  right: 6px;\n  bottom: auto;/);
});

test('the Sortie shows the whole project to begin with; its button released, the kind of the mode only', async () => {
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] },
    clip = { id: 'v', name: 'Clip', roles: {}, limits: sizes, size: { width: 768, height: 448 }, settings: [] },
    runs = [
      { id: 's1', mediaType: 'audio', prompt: 'un son', outputs: [{ originalUrl: '/s1.wav' }] },
      { id: 'c1', mediaType: 'video', prompt: 'un clip', outputs: [{ originalUrl: '/c1.mp4', thumbUrl: '/c1.jpg' }] },
      { id: 'p1', prompt: 'une image', outputs: [{ originalUrl: '/p1.png' }] },
    ];
  let page = await studioPage({ create_image: [image], create_video: [clip] }, {}, { runs });
  try {
    const { body } = page,
      go = () => body.find('studio-sort-go')[0],
      ids = () => body.find('studio-item').map(tile => tile.dataset.id);
    // To begin with (16/11), in Image: everything of the project, sounds and clips with the images,
    // the newest at the left, each with its number; the button pressed.
    assert.deepEqual(ids(), ['s1', 'c1', 'p1']);
    assert.equal(go().attributes['aria-label'], 'Trier la Sortie · tout');
    assert.equal(go().attributes['aria-pressed'], 'true');
    assert.deepEqual(body.find('studio-item-number').map(badge => badge.textContent), ['#3', '#2', '#1']);
    // Another mode: still everything.
    page.mode(1);
    assert.deepEqual(ids(), ['s1', 'c1', 'p1']);
    // Released: the kind of the mode (capture 20: no clip among the images); a creation keeps its number.
    go().onclick();
    assert.deepEqual(ids(), ['c1']);
    assert.equal(go().attributes['aria-label'], 'Trier la Sortie · vidéos');
    assert.equal(go().attributes['aria-pressed'], 'false');
    assert.deepEqual(body.find('studio-item-number').map(badge => badge.textContent), ['#2']);
    // It stays released from one mode to the other, until it is pressed again.
    page.mode(0);
    assert.deepEqual(ids(), ['p1']);
    assert.equal(go().attributes['aria-label'], 'Trier la Sortie · images');
    go().onclick();
    assert.deepEqual(ids(), ['s1', 'c1', 'p1']);
  } finally {
    page.restore();
  }
  // Released on a kind with nothing made: said so, the button still there to show the others.
  page = await studioPage({ create_image: [image] }, {}, { runs: [runs[0]] });
  try {
    const { body } = page;
    assert.deepEqual(body.find('studio-item').map(tile => tile.dataset.id), ['s1']);
    body.find('studio-sort-go')[0].onclick();
    assert.equal(body.find('studio-item').length, 0);
    assert.equal(
      body.find('studio-empty-strip')[0].children[0].textContent,
      'Rien pour l’instant. Vos images apparaîtront ici, la dernière à gauche.',
    );
    body.find('studio-sort-go')[0].onclick();
    assert.deepEqual(body.find('studio-item').map(tile => tile.dataset.id), ['s1']);
  } finally {
    page.restore();
  }
});

// ------------------------------------------------------------------ a creation looked at on the screen (16/11)
const lookModels = () => {
  const krea = {
      id: 'k',
      name: 'Krea 2',
      family: 'krea2',
      seeded: true,
      direct: true,
      roles: { source: { count: 1, media: ['image'] } },
      inputs: { img2img: 'source' },
      limits: sizes,
      size: { width: 1024, height: 1024 },
      settings: [{ key: 'steps', type: 'number', min: 1, max: 50, default: 8 }],
    },
    clip = {
      id: 'v',
      name: 'Clip',
      family: 'ltx25',
      seeded: true,
      direct: true,
      roles: { start_image: { count: 1, media: ['image'] } },
      inputs: { start_image: 'start_image' },
      limits: sizes,
      size: { width: 768, height: 448 },
      lengths: { seconds: [121 / 24, 193 / 24], standard: 121 / 24 },
      settings: [],
    };
  const sound = { id: 's', name: 'Bruitages', roles: {}, settings: [{ key: 'seconds', type: 'number', min: 1, max: 30, default: 10 }] };
  return { create_image: [krea], create_video: [clip], create_audio: [sound] };
};
const lookRuns = () => [
  {
    id: 'film',
    conversationId: 'c2',
    mediaType: 'video',
    workflowId: 'v',
    workflowName: 'Clip',
    prompt: 'un renard court dans la neige',
    parameters: { width: 1344, height: 768, frames: 193, fps: 24, seed: 777, references: [{ role: 'start_image', output_id: 'fox' }] },
    outputs: [{ originalUrl: '/film.mp4', thumbUrl: '/film.jpg', take: 9 }],
  },
  {
    id: 'fox',
    conversationId: 'c1',
    workflowId: 'k',
    workflowName: 'Krea 2',
    prompt: 'un renard',
    parameters: { width: 768, height: 1344, steps: 20, seed: 4242 },
    outputs: [{ originalUrl: '/fox.png', thumbUrl: '/fox.jpg', take: 3 }],
  },
];
const dropOn = (page, transfer) =>
  page.body.find('studio-stage')[0].ondrop({ preventDefault() {}, stopPropagation() {}, dataTransfer: transfer });
const seedOf = async page => {
  await page.body.find('studio-go')[0].onclick();
  await settle();
  return page.asked.findLast(([route]) => route === 'tools/action')[1].arguments;
};
const lookRoutes = {
  'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
  'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }),
};

test('a take dropped on the screen is shown there with all that made it, its very seed, « Plus de réglages » open; « Revenir » gives the Studio back', async () => {
  const page = await studioPage(lookModels(), lookRoutes, { runs: lookRuns(), project: () => 'p1' });
  const { body, studio, restore } = page;
  const back = () => body.find('studio-look-back')[0],
    onScreen = () => body.find('studio-frame-result')[0]?.src ?? null,
    slots = () => body.find('studio-slot').map(tile => tile.children[0].children[0]?.src ?? null);
  try {
    // The conversation « c1 »: its image on the screen, its settings (not its seed: it was drawn).
    assert.equal(body.dataset.mode, 'image');
    assert.equal(onScreen(), '/fox.png');
    assert.equal(back(), undefined, 'nothing looked at: no way back');
    page.prompt().value = 'mon idée en cours';
    page.prompt().oninput();
    assert.equal(body.find('studio-rare')[0].hidden, true);
    // The clip of another conversation of the project, dragged from the Sortie to the screen.
    const film = body.find('studio-item').find(tile => tile.dataset.id === 'film'),
      transfer = { files: [], types: [], setData() {} };
    film.find('studio-item-pick')[0].ondragstart({ dataTransfer: transfer });
    const stage = body.find('studio-stage')[0],
      over = { preventDefault: () => (over.taken = true), dataTransfer: transfer };
    stage.ondragover(over);
    assert.equal(over.taken, true, 'the screen takes it');
    dropOn(page, transfer);
    // Its kind is open, it is on the screen, and the Studio is as it was to make it.
    assert.equal(body.dataset.mode, 'video');
    assert.equal(onScreen(), '/film.mp4');
    assert.equal(page.prompt().value, 'un renard court dans la neige');
    assert.deepEqual(slots(), ['/fox.jpg'], 'its start image back in its case');
    assert.equal(body.find('studio-rare')[0].hidden, false, '« Plus de réglages » open');
    // The actions of that take, on the bar of the screen.
    assert.ok(body.find('output-actions')[0].children.length > 0);
    let args = await seedOf(page);
    assert.deepEqual([args.width, args.height, args.seed], [1344, 768, 777], 'its very seed');
    assert.ok(Math.abs(args.duration - 193 / 24) < 1e-9);
    // « Revenir », at the right of « Image · Vidéo · Son »: the clip leaves, the Studio is as before.
    assert.equal(back().children.at(-1).textContent, 'Revenir');
    assert.match(back().title, /remettre vos réglages d’avant/);
    back().onclick();
    assert.equal(body.dataset.mode, 'image');
    assert.equal(onScreen(), '/fox.png');
    assert.equal(page.prompt().value, 'mon idée en cours');
    assert.equal(body.find('studio-rare')[0].hidden, true);
    assert.equal(back(), undefined);
    args = await seedOf(page);
    assert.deepEqual([args.width, args.height, args.steps, args.seed], [768, 1344, 20, undefined]);
    // « Afficher dans le Studio », from the chat: the same.
    studio.show(lookRuns()[0]);
    assert.equal(body.dataset.mode, 'video');
    assert.equal(page.prompt().value, 'un renard court dans la neige');
    assert.ok(back());
    // Looked at twice in a row: « Revenir » still leads to the Studio of before the first.
    studio.show(lookRuns()[1]);
    assert.equal(page.prompt().value, 'un renard');
    assert.equal((await seedOf(page)).seed, 4242);
    back().onclick();
    assert.equal(page.prompt().value, 'mon idée en cours');
    // An image of a case is not a creation to look at: the screen leaves it.
    const slotDrag = { preventDefault: () => (slotDrag.taken = true), dataTransfer: { types: [], files: [] } };
    body.find('studio-stage')[0].ondragover(slotDrag);
    assert.equal(slotDrag.taken, undefined);
  } finally {
    restore();
  }
});

test('a file dropped on the screen: one Moodix made says what made it, whatever its name; one from elsewhere changes no setting', async () => {
  const { mp4Box, pngChunk } = await import('../public/media-info.mjs');
  const be = value => {
      const bytes = Buffer.alloc(4);
      bytes.writeUInt32BE(value);
      return bytes;
    },
    box = (type, data) => Buffer.concat([be(8 + data.length), Buffer.from(type, 'ascii'), data]),
    film = Buffer.concat([box('ftyp', Buffer.from('isomiso2', 'latin1')), box('mdat', Buffer.alloc(32))]),
    signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    picture = sheet => Buffer.concat([signature, box2('IHDR', Buffer.alloc(13)), ...(sheet ? [Buffer.from(pngChunk(sheet))] : []), box2('IEND', Buffer.alloc(0))]),
    box2 = (type, data) => Buffer.concat([be(data.length), Buffer.from(type, 'ascii'), data, be(0)]),
    file = (bytes, name, type) => new File([bytes], name, { type });
  const page = await studioPage(lookModels(), lookRoutes, { runs: lookRuns(), project: () => 'p1' });
  const { body, notices, restore } = page;
  const back = () => body.find('studio-look-back')[0],
    onScreen = () => body.find('studio-frame-result')[0]?.src ?? null,
    drop = async dropped => {
      dropOn(page, { files: [dropped], types: ['Files'] });
      await settle();
    };
  try {
    page.prompt().value = 'mon idée en cours';
    page.prompt().oninput();
    // A clip of this project, renamed on the disk: its sheet names it; it is that take.
    await drop(file(Buffer.concat([film, Buffer.from(mp4Box({ moodix: 1, id: 'film', mediaType: 'video' }))]), 'vacances (1).mp4', 'video/mp4'));
    assert.equal(body.dataset.mode, 'video');
    assert.equal(onScreen(), '/film.mp4', 'the take itself, not a copy of the file');
    assert.equal(page.prompt().value, 'un renard court dans la neige');
    assert.equal((await seedOf(page)).seed, 777);
    back().onclick();
    // An image Moodix made elsewhere (another project, another computer): kept as a reference of the
    // project, shown from there, with what its sheet says made it.
    const elsewhere = { moodix: 1, id: 'ailleurs', mediaType: 'image', workflowId: 'k', workflowName: 'Krea 2', prompt: 'un phare', parameters: { width: 1344, height: 768, steps: 30, seed: 99 } };
    await drop(file(picture(elsewhere), 'phare.png', 'image/png'));
    assert.equal(body.dataset.mode, 'image');
    assert.equal(onScreen(), '/preview/phare.png');
    assert.equal(page.prompt().value, 'un phare');
    assert.equal(body.find('studio-rare')[0].hidden, false);
    let made = await seedOf(page);
    assert.deepEqual([made.width, made.height, made.steps, made.seed], [1344, 768, 30, 99]);
    // Its actions take it as a reference of the project.
    assert.ok(body.find('output-actions')[0].children.length > 0);
    back().onclick();
    assert.equal(page.prompt().value, 'mon idée en cours');
    // Made with a model this installation does not have: said, the settings untouched.
    await drop(file(picture({ ...elsewhere, workflowId: 'inconnu', workflowName: 'Flux 3' }), 'flux.png', 'image/png'));
    assert.equal(page.prompt().value, 'mon idée en cours');
    assert.equal(body.find('studio-error')[0].textContent, 'Créé avec Flux 3, qui n’est pas disponible ici : vos réglages sont restés tels quels.');
    back().onclick();
    // A photo from elsewhere: on the screen, and nothing of the settings changes.
    await drop(file(picture(null), 'photo.png', 'image/png'));
    assert.equal(onScreen(), '/preview/photo.png');
    assert.equal(page.prompt().value, 'mon idée en cours');
    assert.equal(body.find('studio-rare')[0].hidden, true);
    assert.equal(body.find('studio-error').length, 0);
    made = await seedOf(page);
    assert.deepEqual([made.steps, made.seed], [20, undefined], 'the settings of before');
    assert.ok(back());
    back().onclick();
    assert.equal(onScreen(), '/fox.png');
    // A sound: its kind opens, it plays from the file itself; no action on a sound.
    const made0 = [],
      given = [],
      urls = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = blob => (made0.push(blob), 'blob:son');
    URL.revokeObjectURL = address => given.push(address);
    try {
      await drop(file(Buffer.from('RIFF\x24\0\0\0WAVEfmt ', 'latin1'), 'pluie.wav', 'audio/wav'));
      assert.equal(body.dataset.mode, 'audio');
      back().onclick();
      assert.deepEqual(given, ['blob:son'], 'the address of the file given back');
    } finally {
      URL.createObjectURL = urls.create;
      URL.revokeObjectURL = urls.revoke;
    }
    // Neither an image, a clip nor a sound: said, nothing changes.
    await drop(file(Buffer.from('%PDF-1.7'), 'notes.pdf', 'application/pdf'));
    assert.match(notices.at(-1), /ni une image, ni une vidéo, ni un son/);
    assert.equal(back(), undefined);
  } finally {
    restore();
  }
  // A kind no model makes here has no screen to open: said, nothing changes, nothing is kept.
  const { create_image } = lookModels(),
    alone = await studioPage({ create_image }, lookRoutes, { runs: [lookRuns()[1]], project: () => 'p1' });
  try {
    dropOn(alone, { files: [file(Buffer.from('RIFF\x24\0\0\0WAVEfmt ', 'latin1'), 'pluie.wav', 'audio/wav')], types: ['Files'] });
    await settle();
    assert.equal(alone.notices.at(-1), 'Aucun modèle de son n’est prêt : ce média ne peut pas être montré dans le Studio.');
    assert.equal(alone.body.dataset.mode, 'image');
    assert.equal(alone.body.find('studio-look-back').length, 0);
  } finally {
    alone.restore();
  }
});

test('the take on the screen is a little smaller than its frame and rounded on its own, whatever the format chosen', async () => {
  const read = async name => (await (await import('node:fs/promises')).readFile(new URL('../public/' + name, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const css = await read('moodix.css'),
    rule = selector => {
      const at = css.lastIndexOf('\n' + selector + ' {\n');
      assert.ok(at >= 0, selector);
      return css.slice(at, css.indexOf('\n}\n', at));
    };
  // 8 px all around, in the middle of the frame, corners of its own.
  const take = rule('#studio-view .studio-frame > :is(img, video).studio-frame-result');
  assert.match(take, /width: calc\(100% - 16px\);/);
  assert.match(take, /height: calc\(100% - 16px\);/);
  assert.match(take, /border-radius: 10px;/);
  assert.match(take, /top: 50%;\n  left: 50%;/);
  assert.match(take, /transform: translate\(-50%, -50%\);/);
  // Its box has its own shape, as large as the frame allows: rounded even in a frame of another format.
  const shaped = rule("#studio-view .studio-frame > :is(img, video).studio-frame-result[style*='--media-ratio']");
  assert.match(shaped, /width: min\(100cqw - 16px, \(100cqh - 16px\) \* var\(--media-ratio\)\);/);
  assert.match(shaped, /aspect-ratio: var\(--media-ratio\);/);
  assert.match(rule('#studio-view .studio-frame'), /container-type: size;/);
  // That shape is said by the Studio: from the record at once, from the picture once it is read.
  const video = { id: 'v', name: 'Clip', roles: {}, limits: sizes, size: { width: 768, height: 448 }, settings: [] },
    clip = { id: 'c', mediaType: 'video', prompt: 'un renard', outputs: [{ originalUrl: '/clip.mp4' }], parameters: { width: 768, height: 448, frames: 121, fps: 24 } };
  const page = await studioPage({ create_video: [video] }, {}, { runs: [clip] });
  try {
    const [shown] = page.body.find('studio-frame-result'),
      said = [];
    shown.style.setProperty = (name, value) => said.push([name, value]);
    shown.videoWidth = 1024;
    shown.videoHeight = 1024;
    shown.onloadedmetadata();
    assert.deepEqual(said, [['--media-ratio', '1.0000']]);
  } finally {
    page.restore();
  }
  const source = await read('studio.mjs');
  assert.match(source, /const known = sizeOfRecord\(record\);\n    if \(known\) shaped\(known\.width, known\.height\);/);
});

test('Moodix AI continues a clip of the disk (« #ref1 »): the Studio shows that clip being continued, not the empty cases of a new video', async () => {
  // As the application describes them: a new video with LTX 2.5 takes a start, an end and references;
  // a continuation takes its clip alone.
  const create = {
      id: 'ltx',
      name: 'LTX 2.5',
      verb: 'create_video',
      roles: { start_image: { count: 1, media: ['image'] }, end_image: { count: 1, media: ['image'] }, reference: { count: 2, media: ['image'], many: true } },
      exclusive: [['source'], ['reference']],
      limits: sizes,
      size: { width: 768, height: 448 },
      stages: true,
      seeded: true,
      lengths: { seconds: [121 / 24, 145 / 24], standard: 121 / 24 },
      settings: [],
    },
    extend = {
      ...create,
      verb: 'extend_video',
      roles: { source: { count: 1, media: ['video'], many: false, required: true }, reference: { count: 0, media: [], many: true } },
      lengths: { seconds: [4, 5, 6], standard: 5 },
    },
    view = { id: '5126b40d', name: 'view.mp4', label: '#ref1', width: 1152, height: 2048, originalUrl: '/media/view/original', previewUrl: '/media/view/preview' },
    request = {
      requestId: 'q1',
      approvalToken: 't1',
      tool: 'extend_video',
      mediaType: 'video',
      workflowName: 'LTX 2.5',
      resolution: { width: 1152, height: 2048 },
      call: { id: 'call1', type: 'function', function: { name: 'extend_video', arguments: '{}' } },
      plan: {
        prompt: 'The video ends with a cut to a distant staircase climbing through clouds.',
        stage: 'draft',
        parameters: { width: 1152, height: 2048, frames: 129, fps: 24, seed: 5936987926593958, overlap_frames: 9 },
        editable: { prompt: true, stages: [], parameters: [{ key: 'frames', type: 'integer', value: 129 }], references: [[]] },
        references: [{ input: 'source', role: 'source_video', as: 'source', resource_id: '5126b40d', label: '#ref1 · view.mp4', roleLabel: 'Vidéo à prolonger' }],
        loras: [],
      },
    };
  const said = [];
  const page = await studioPage(
    { create_video: [create], extend_video: [extend] },
    {},
    { runs: [], cursor: said, targets: true, resource: id => (id === view.id ? view : null) },
  );
  const { body, studio, restore } = page;
  try {
    const answer = studio.propose(structuredClone(request), new AbortController().signal);
    await until(() => said.includes('attend votre accord'));
    assert.equal(body.dataset.mode, 'video');
    // The clip continued is named, and on the screen: it is not a take of the Sortie.
    assert.equal(body.find('studio-extending')[0].children[1].textContent, 'Suite du clip : view.mp4');
    const [shown] = body.find('studio-frame-result');
    assert.deepEqual([shown.tag, shown.src, shown.poster], ['video', '/media/view/original', '/media/view/preview']);
    assert.equal(body.find('studio-go-label')[0].textContent, 'Générer la suite');
    // Not the cases of a new video (« Début et fin », « Références »), which have nothing to do with it.
    const titles = body.find('studio-input-title').map(title => title.textContent);
    assert.equal(titles.includes('Début et fin'), false, titles.join(' | '));
    assert.equal(titles.some(title => title.startsWith('Références')), false, titles.join(' | '));
    // Nor an empty case for « the video to follow »: the clip continued is named above, it is not asked again.
    assert.deepEqual(body.find('studio-slot').map(tile => tile.dataset.slot), [], titles.join(' | '));
    assert.equal(page.prompt().value, request.plan.prompt);
    studio.decline();
    assert.equal(await answer, 'deny');
  } finally {
    restore();
  }
});

test('a proposal without images shows empty cases: an image left there by the user is not part of what will be made', async () => {
  const recorded = await recordedProposal(),
    { tools, runs } = replayStudio(),
    said = [];
  // The same proposal, with no image at all.
  const request = structuredClone(recorded.request);
  request.plan.references = [];
  request.plan.editable.references = [];
  const page = await studioPage(tools, {}, { runs, cursor: said, targets: true });
  const { body, studio, restore } = page;
  const filled = () => body.find('studio-slot').filter(tile => tile.className.includes('is-filled')).map(tile => tile.dataset.slot);
  try {
    // The user had put the take of the project as a start image, by hand.
    page.mode(1);
    const event = { preventDefault() {}, stopPropagation() {}, dataTransfer: { files: [], types: [], setData() {} } };
    body.find('studio-item')[0].find('studio-item-pick')[0].ondragstart(event);
    body.find('studio-slot')[0].ondrop(event);
    assert.equal(filled().length, 1);
    const answer = studio.propose(request, new AbortController().signal);
    await until(() => said.includes('attend votre accord'));
    assert.deepEqual(filled(), [], 'nothing shown that the proposal does not use');
    assert.equal(said.some(word => word.startsWith('pose ')), false);
    studio.decline();
    assert.equal(await answer, 'deny');
  } finally {
    restore();
  }
});

test('a clip of the disk is continued with the model chosen in the Studio, which is said to the server', async () => {
  const roles = { source: { count: 1, media: ['video'], many: false, required: true }, reference: { count: 0, media: [], many: true } },
    lengths = { seconds: [4, 5, 6], standard: 5 },
    base = { limits: sizes, size: { width: 768, height: 448 }, seeded: true, settings: [], lengths },
    create = [
      { ...base, id: 'h3', name: 'MiniMax H3 Omni', verb: 'create_video', roles: {} },
      { ...base, id: 'ltx', name: 'LTX 2.5', verb: 'create_video', roles: {} },
    ],
    extend = create.map(model => ({ ...model, verb: 'extend_video', roles }));
  const page = await studioPage(
    { create_video: create, extend_video: extend },
    {
      'tools/actions': () => ({ extend_video: ['video'] }),
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }),
    },
    { runs: [], project: () => 'p1' },
  );
  const { body, asked, restore } = page;
  try {
    // A video of the computer dropped on the screen: kept as a reference of the project.
    const film = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisomiso2'), Buffer.from([0, 0, 0, 12]), Buffer.from('mdat'), Buffer.alloc(4)]);
    page.mode(1);
    body.find('studio-stage')[0].ondrop({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files: [new File([film], 'view.mp4', { type: 'video/mp4' })], types: ['Files'] } });
    await settle();
    assert.equal(body.find('studio-frame-result')[0].src, '/preview/view.mp4');
    // « Prolonger », on the bar of the screen.
    await settle();
    const extendIt = body.find('output-action-extend')[0];
    assert.ok(extendIt, 'the action is offered for a clip of the disk');
    extendIt.onclick();
    assert.equal(body.find('studio-extending')[0].children[1].textContent, 'Suite du clip : view.mp4');
    assert.equal(body.find('studio-go-label')[0].textContent, 'Générer la suite');
    // No model made this clip: the list of the models that can continue one, to choose from.
    const [model] = body.find('studio-model-pick');
    assert.ok(model, 'the model is chosen');
    model.value = 'ltx';
    model.onchange();
    page.prompt().value = 'La caméra recule et découvre la vallée.';
    page.prompt().oninput();
    await body.find('studio-go')[0].onclick();
    await settle();
    const [, action] = asked.findLast(([route]) => route === 'tools/action');
    assert.equal(action.name, 'extend_video');
    assert.deepEqual(action.arguments.source, { resource: 'r1' });
    assert.equal(action.arguments.workflow, 'ltx', 'the model chosen, not the first of the list');
  } finally {
    restore();
  }
  // A clip made here keeps the model that made it: not chosen, not named (the server knows it).
  const made = { id: 'c', mediaType: 'video', workflowId: 'ltx', prompt: 'un renard', outputs: [{ originalUrl: '/c.mp4', thumbUrl: '/c.jpg' }] };
  const own = await studioPage(
    { create_video: create, extend_video: extend },
    { 'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }), 'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }) },
    { runs: [made] },
  );
  try {
    own.body.find('studio-item')[0].find('studio-item-main')[0].onclick();
    assert.equal(own.body.find('studio-extending').length, 1);
    assert.equal(own.body.find('studio-model-pick').length, 0);
    own.prompt().value = 'Il saute.';
    own.prompt().oninput();
    await own.body.find('studio-go')[0].onclick();
    await settle();
    const [, action] = own.asked.findLast(([route]) => route === 'tools/action');
    assert.deepEqual([action.arguments.source, action.arguments.workflow], [{ output: 'c' }, undefined]);
  } finally {
    own.restore();
  }
});

test('what a proposal of Moodix AI says of itself is read in the Studio, at the head of its column, while it waits', async () => {
  const recorded = await recordedProposal(),
    { tools, runs } = replayStudio(),
    said = [];
  const request = structuredClone(recorded.request),
    note = '#ref2 n’est pas transmise : LTX 2.5 ne prend pas d’image pour la suite d’une vidéo. Le générateur ne la verra pas, seul le prompt peut la décrire.';
  request.notes = [note, 'Durée ajoutée : 10 s → 8 s, la plus proche que LTX 2.5 permet.'];
  const page = await studioPage(tools, {}, { runs, cursor: said, targets: true });
  const { body, studio, restore } = page;
  const notes = () => body.find('studio-proposal-note').map(line => line.textContent);
  try {
    assert.deepEqual(notes(), [], 'nothing to say without a proposal');
    const answer = studio.propose(request, new AbortController().signal);
    await until(() => said.includes('attend votre accord'));
    assert.deepEqual(notes(), request.notes);
    // In the column of the inputs, before the prompt: read without scrolling it.
    const [write] = body.find('studio-write')[0].find('studio-block-body'),
      at = name => write.children.findIndex(child => String(child.className).includes(name));
    assert.ok(at('studio-proposal-note') >= 0 && at('studio-proposal-note') < at('studio-prompt-field'), 'above the prompt');
    studio.decline();
    assert.equal(await answer, 'deny');
    assert.deepEqual(notes(), [], 'gone with the proposal');
  } finally {
    restore();
  }
});

/** An image model, a video model and what continues a clip, with a clip and an image of the conversation. */
function continuing({ more = true } = {}) {
  const image = { id: 'k', name: 'Krea 2', verb: 'create_image', direct: true, roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] },
    clip = {
      id: 'v',
      name: 'LTX 2.5',
      verb: 'create_video',
      seeded: true,
      roles: { start_image: { count: 1, media: ['image'] } },
      limits: sizes,
      size: { width: 768, height: 448 },
      lengths: { seconds: [121 / 24, 193 / 24, 241 / 24], standard: 121 / 24 },
      settings: [],
    },
    // What it adds to a clip: its frames less those it takes again (9).
    extend = { ...clip, verb: 'extend_video', roles: { source: { count: 1, media: ['video'], required: true } }, lengths: { seconds: [112 / 24, 184 / 24, 232 / 24], standard: 112 / 24 } },
    runs = [
      // The newest of the conversation is an image: the Studio opens in Image.
      { id: 'fox', conversationId: 'c1', workflowId: 'k', prompt: 'un renard', parameters: { width: 1024, height: 1024 }, outputs: [{ originalUrl: '/fox.png', thumbUrl: '/fox.jpg', take: 2 }] },
      { id: 'film', conversationId: 'c1', mediaType: 'video', workflowId: 'v', prompt: 'un renard court', parameters: { width: 1344, height: 768, frames: 121, fps: 24 }, outputs: [{ originalUrl: '/film.mp4', thumbUrl: '/film.jpg', take: 1 }] },
    ];
  return { tools: { create_image: [image], create_video: [clip], ...(more ? { extend_video: [extend] } : {}) }, runs };
}
const prolonger = (body, id = 'film') => body.find('studio-item').find(tile => tile.dataset.id === id).find('studio-item-main')[0];

test('« Prolonger » on a clip of the Sortie opens Vidéo with its banner, from Image too; greyed with its reason when nothing continues a video', async () => {
  const { tools, runs } = continuing();
  let page = await studioPage(
    tools,
    { 'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }), 'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }) },
    { runs },
  );
  try {
    const { body, asked } = page;
    // In Image, the Sortie shows the whole project: the clip is there with its « Prolonger ».
    assert.equal(body.dataset.mode, 'image');
    assert.equal(prolonger(body).attributes['aria-disabled'], undefined);
    prolonger(body).onclick();
    // A continuation is made in Vidéo: its banner with « Annuler », no format to choose.
    assert.equal(body.dataset.mode, 'video');
    assert.equal(body.find('studio-extending')[0].children[1].textContent, 'Suite du clip : un renard court');
    assert.equal(body.find('studio-extending')[0].find('studio-link').length, 1);
    assert.equal(body.find('studio-go-label')[0].textContent, 'Générer la suite');
    page.prompt().value = 'il s’arrête';
    page.prompt().oninput();
    await body.find('studio-go')[0].onclick();
    await settle();
    const [, action] = asked.find(([route]) => route === 'tools/action');
    assert.equal(action.name, 'extend_video');
    assert.deepEqual(action.arguments.source, { output: 'film' });
    // Image is as it was: its formats, « Générer ».
    page.mode(0);
    assert.equal(body.find('studio-formats').length, 1);
    assert.equal(body.find('studio-go-label')[0].textContent, 'Générer');
    assert.deepEqual(body.find('studio-extending'), []);
  } finally {
    page.restore();
  }
  // No workflow continues a video: « Prolonger » is greyed and says why; pressed, the Studio stays.
  const alone = continuing({ more: false });
  alone.runs.reverse();
  page = await studioPage(alone.tools, {}, { runs: alone.runs });
  try {
    const { body, notices } = page;
    assert.equal(body.dataset.mode, 'video');
    const main = prolonger(body);
    assert.equal(main.attributes['aria-disabled'], 'true');
    assert.match(main.className, /is-off/);
    assert.match(main.title, /Aucun workflow ne sait prolonger une vidéo\./);
    main.onclick();
    assert.equal(notices.at(-1), 'Aucun workflow ne sait prolonger une vidéo.');
    assert.equal(body.find('studio-go').length, 1, 'the Studio is still there');
    assert.equal(body.find('studio-item').length, 2);
    assert.deepEqual(body.find('studio-extending'), []);
    // In its menu too.
    body.find('studio-item').find(tile => tile.dataset.id === 'film').oncontextmenu({ preventDefault() {} });
    const entry = body.find('studio-menu-item').find(item => item.children.at(-1).textContent === 'Prolonger');
    assert.equal(entry.attributes['aria-disabled'], 'true');
    entry.onclick();
    assert.equal(body.find('studio-go').length, 1);
  } finally {
    page.restore();
  }
});

/** The continuation of the clip of `continuing()`, as Moodix AI proposes it: 193 frames, 9 of them taken again. */
function continuation() {
  const prompt = 'Le renard s’arrête et regarde la caméra';
  return {
    requestId: 'q',
    approvalToken: 't',
    tool: 'extend_video',
    mediaType: 'video',
    workflowName: 'LTX 2.5',
    resolution: { width: 1344, height: 768 },
    call: { id: 'call', type: 'function', function: { name: 'extend_video', arguments: '{}' } },
    plan: {
      prompt,
      stage: 'final',
      parameters: { prompt, width: 1344, height: 768, frames: 193, fps: 24, overlap_frames: 9, seed: 7 },
      editable: {
        prompt: true,
        stages: [],
        parameters: [
          { key: 'frames', type: 'integer', value: 193, choices: [121, 193, 241] },
          { key: 'width', type: 'integer', value: 1344, locked: 'Une continuation garde la taille de sa vidéo source.' },
          { key: 'height', type: 'integer', value: 768, locked: 'Une continuation garde la taille de sa vidéo source.' },
          { key: 'seed', type: 'integer', value: 7 },
        ],
        references: [[]],
      },
      references: [{ input: 'source', role: 'source_video', as: 'source', roleLabel: 'Vidéo à prolonger', label: 'Prise 1', output_id: 'film' }],
    },
  };
}

test('a continuation proposed by Moodix AI stays one while it waits: another mode visited, « Prolonger » on another clip, « Revenir »', async () => {
  const { tools, runs } = continuing();
  runs.push({ id: 'other', conversationId: 'c1', mediaType: 'video', workflowId: 'v', prompt: 'une mouette', parameters: { width: 768, height: 448, frames: 121, fps: 24 }, outputs: [{ originalUrl: '/other.mp4', thumbUrl: '/other.jpg', take: 0 }] });
  const sent = [];
  const page = await studioPage(tools, { 'tools/revise': ({ edits }) => (sent.push(edits), { requestId: 'q2', approvalToken: 't2' }) }, { runs });
  const { body, studio, notices, restore } = page;
  const shown = () => ({
    banner: body.find('studio-extending')[0]?.children[1].textContent ?? null,
    go: body.find('studio-go-label')[0].textContent,
    formats: body.find('studio-formats').length,
    duration: body.find('studio-bar').find(bar => bar.dataset.ai === 'duration')?.attributes['aria-valuetext'],
  });
  try {
    // The image of the conversation is looked at first: « Revenir » is offered.
    studio.show(runs[0]);
    assert.equal(body.find('studio-look-back').length, 1);
    const answer = studio.propose(continuation(), new AbortController().signal);
    await settle();
    const proposed = { banner: 'Suite du clip : un renard court', go: 'Générer la suite', formats: 0, duration: '07.67 S' };
    assert.deepEqual(shown(), proposed);
    // The other modes still work by hand: the user looks at Image, then comes back.
    page.mode(0);
    assert.deepEqual(body.find('studio-extending'), []);
    // No way back to the settings of before while it waits: they would come under the proposal.
    assert.deepEqual(body.find('studio-look-back'), []);
    page.mode(1);
    assert.deepEqual(shown(), proposed, 'still the continuation of its clip');
    assert.equal(body.find('studio-decline').length, 1);
    // « Prolonger » on another clip is held, and says why.
    const other = prolonger(body, 'other');
    assert.equal(other.attributes['aria-disabled'], 'true');
    other.onclick();
    assert.equal(notices.at(-1), 'Moodix AI est en train de proposer');
    assert.deepEqual(shown(), proposed);
    // Nothing touched: nothing is sent as a change of the user.
    await body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    assert.deepEqual(sent, []);
    await studio.settled({ record: null });
    // Answered: the way back is offered again.
    assert.equal(body.find('studio-look-back').length, 1);
  } finally {
    restore();
  }
});

test('the images of a proposal change role as the server offers, said by its own names; answered, they are the user’s and move freely', async () => {
  const recorded = await recordedProposal(),
    { tools, runs } = replayStudio(),
    sent = [];
  const page = await studioPage(tools, { 'tools/revise': ({ edits }) => (sent.push(edits), { requestId: 'q2', approvalToken: 't2' }) }, { runs });
  const { body, studio, restore } = page;
  const event = files => ({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files, setData() {} } }),
    drag = (from, to) => {
      body.find('studio-slot')[from].children[0].ondragstart(event([]));
      body.find('studio-slot')[to].ondrop(event([]));
    },
    shown = () => body.find('studio-slot').map(tile => tile.children[0].children[0]?.src ?? null),
    error = () => body.find('studio-error')[0]?.textContent ?? null;
  try {
    // The fixture lists the roles as the server does (lib/tool-runtime.mjs, referenceRoles): by the
    // names of the slots of the family, « msr_image » for a reference of LTX 2.5.
    assert.deepEqual(
      recorded.request.plan.editable.references[0].map(choice => choice.role),
      ['start_image', 'end_image', 'msr_image'],
    );
    let answer = studio.propose(structuredClone(recorded.request), new AbortController().signal);
    await settle();
    assert.deepEqual(shown(), ['/portrait.webp', null, null]);
    // To « Référence »: a role the server offers, under its own name.
    drag(0, 2);
    assert.equal(error(), null);
    assert.deepEqual(shown(), [null, null, '/portrait.webp', null]);
    await body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    // Said to the server by the name it gave that role.
    assert.deepEqual(sent, [{ references: [{ index: 0, role: 'msr_image' }] }]);
    await studio.settled({ record: null });
    // Answered: the image is the user's, it goes where they put it.
    drag(2, 0);
    assert.equal(error(), null);
    assert.deepEqual(shown(), ['/portrait.webp', null, null]);
    body.find('studio-swap')[0].onclick();
    assert.equal(error(), null);
    assert.deepEqual(shown(), [null, '/portrait.webp', null]);
    // Declined instead: the same.
    answer = studio.propose(structuredClone(recorded.request), new AbortController().signal);
    await settle();
    assert.deepEqual(shown(), ['/portrait.webp', null, null]);
    studio.decline();
    assert.equal(await answer, 'deny');
    body.find('studio-swap')[0].onclick();
    assert.equal(error(), null);
    assert.deepEqual(shown(), [null, '/portrait.webp', null]);
    // While a proposal waits, a role the server does not offer its image stays refused.
    const narrow = structuredClone(recorded.request);
    narrow.plan.editable.references = [[{ role: 'start_image', label: 'Image de début' }]];
    answer = studio.propose(narrow, new AbortController().signal);
    await settle();
    drag(0, 1);
    assert.equal(error(), 'Image de fin : ce rôle n’est pas possible pour cette image avec ce workflow.');
    assert.deepEqual(shown(), ['/portrait.webp', null, null]);
    studio.decline();
    assert.equal(await answer, 'deny');
  } finally {
    restore();
  }
});

test('a proposal that starts from an image joined to the message shows it in its slot; answered, nothing without a source is left to send', async () => {
  const { tools } = continuing();
  const page = await studioPage(
    tools,
    { 'tools/action': () => ({ requestId: 'h', plan: { parameters: {} } }), 'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }) },
    { runs: [] },
  );
  const { body, studio, asked, restore } = page;
  const prompt = 'La mer monte';
  // As lib/tool-runtime.mjs resolves an image joined to the message: neither a take nor a reference.
  const joined = () => ({
    requestId: 'q',
    approvalToken: 't',
    tool: 'create_video',
    mediaType: 'video',
    workflowName: 'LTX 2.5',
    resolution: { width: 768, height: 448 },
    call: { id: 'call', type: 'function', function: { name: 'create_video', arguments: '{}' } },
    plan: {
      prompt,
      parameters: { prompt, width: 768, height: 448, frames: 121, fps: 24, seed: 7 },
      editable: { prompt: true, parameters: [], references: [[{ role: 'start_image', label: 'Image de début' }]] },
      references: [
        { input: 'start', image: 0, attachment: 'a1b2.png', original: true, label: 'Image 1', role: 'start_image', as: 'start_image', roleLabel: 'Image de début', preview: '/media/attachments/c1/a1b2.png' },
      ],
    },
  });
  const tile = () => body.find('studio-slot')[0];
  try {
    let answer = studio.propose(joined(), new AbortController().signal);
    await settle();
    // Its picture, the one the server gives for the card of the proposal.
    assert.match(tile().className, /is-filled/);
    assert.equal(tile().children[0].children[0].src, '/media/attachments/c1/a1b2.png');
    await body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    await studio.settled({ record: null });
    // Answered: the Studio cannot name that image (no take, no reference): its slot is empty again.
    assert.doesNotMatch(tile().className, /is-filled/);
    page.prompt().value = 'La mer monte encore';
    page.prompt().oninput();
    await body.find('studio-go')[0].onclick();
    await settle();
    const [, action] = asked.findLast(([route]) => route === 'tools/action');
    assert.equal('start_image' in action.arguments, false, 'no input without a source is sent');
    // Refused instead: the same.
    answer = studio.propose(joined(), new AbortController().signal);
    await settle();
    assert.match(tile().className, /is-filled/);
    studio.decline();
    assert.equal(await answer, 'deny');
    assert.doesNotMatch(tile().className, /is-filled/);
  } finally {
    restore();
  }
});

test('on a proposal, the size chosen is what is made: its format and its size go with « final » when it is one', async () => {
  const sent = [];
  // As the server answers (lib/tool-runtime.mjs, revise): another version keeps the format of the
  // size given with it and takes the size of its own profile; a size alone is taken as it is.
  const revise = ({ edits }) => {
    sent.push(edits);
    const size = !edits.stage
      ? { width: edits.width, height: edits.height }
      : edits.width < edits.height
        ? { width: 768, height: 1344 }
        : { width: 1344, height: 768 };
    return { requestId: 'q' + sent.length, approvalToken: 't' + sent.length, plan: { stage: edits.stage ?? 'draft', parameters: size } };
  };
  const { clip } = proposalOf();
  const page = await studioPage({ create_video: [clip] }, { 'tools/revise': revise });
  const { body, studio, restore } = page;
  const size = () => body.find('studio-bar').find(bar => bar.dataset.ai === 'size'),
    choose = place => {
      const bar = size();
      bar.value = String(place);
      bar.oninput();
    },
    proposed = async () => {
      const { request } = proposalOf(),
        answer = studio.propose(request, new AbortController().signal);
      await settle();
      assert.equal(size().attributes['aria-valuetext'], '768 × 448');
      return { request, answer };
    },
    generated = async ({ request, answer }) => {
      await body.find('studio-go')[0].onclick();
      assert.equal(await answer, 'once');
      await studio.settled({ record: null });
      return [sent.splice(0), request.requestId];
    };
  try {
    // A smaller draft: its size, nothing else.
    let waiting = await proposed();
    choose(0);
    assert.deepEqual(await generated(waiting), [[{ width: 512, height: 288 }], 'q1']);
    // Another format and a size that is a final: both go with « final », and the server gives them.
    waiting = await proposed();
    body.find('studio-format').find(chip => chip.children.at(-1)?.textContent === '9:16').onclick();
    choose(3);
    assert.equal(size().attributes['aria-valuetext'], '768 × 1344');
    assert.deepEqual(await generated(waiting), [[{ width: 768, height: 1344, stage: 'final' }], 'q1']);
    // A final larger than its profile: the server answers with the size of the profile, the size
    // chosen is asked again alone, and what is generated is that last proposal.
    waiting = await proposed();
    choose(5);
    assert.equal(size().attributes['aria-valuetext'], '1920 × 1088');
    assert.deepEqual(await generated(waiting), [
      [
        { width: 1920, height: 1088, stage: 'final' },
        { width: 1920, height: 1088 },
      ],
      'q2',
    ]);
  } finally {
    restore();
  }
});

test('what comes back late is not written elsewhere: a prompt improved for a conversation left, a file imported once another mode is shown', async () => {
  const krea = { id: 'k', name: 'Krea 2', verb: 'create_image', direct: true, roles: { source: { count: 1, media: ['image'] } }, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] },
    scail = {
      id: 's',
      name: 'SCAIL-2',
      verb: 'replace_character',
      follows: true,
      roles: { source: { count: 1, media: ['video'], required: true }, reference: { count: 1, media: ['image'], required: true } },
      settings: [],
    },
    runs = [
      { id: 't2', conversationId: 'c2', workflowId: 'k', prompt: 'la prise de la conversation 2', parameters: { width: 1024, height: 1024 }, outputs: [{ originalUrl: '/t2.png', thumbUrl: '/t2.jpg', take: 1 }] },
    ];
  let conversation = 'c1',
    answer = null;
  const page = await studioPage(
    { create_image: [krea], replace_character: [scail] },
    {
      'studio/enrich': () => new Promise(resolve => (answer = resolve)),
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }),
    },
    { runs, conversation: () => conversation },
  );
  const { body, studio, notices, asked, restore } = page;
  const event = files => ({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files, setData() {} } }),
    slots = () => body.find('studio-slot').map(tile => [tile.dataset.slot, tile.children[0].children[0]?.src ?? null]);
  try {
    // « Améliorer le prompt » in the first conversation; the chat model takes its time.
    page.prompt().value = 'un chat roux';
    page.prompt().oninput();
    void body.find('studio-enrich-go')[0].onclick();
    await settle();
    assert.equal(typeof answer, 'function');
    // Meanwhile the second conversation is opened: its Studio is set at once, as its last take was made.
    conversation = 'c2';
    studio.conversationChanged();
    await settle();
    assert.equal(page.prompt().value, 'la prise de la conversation 2');
    answer({ prompt: 'Un chat roux assis sur un mur de pierre, lumière dorée.' });
    await settle();
    // The answer is for the conversation left: nothing of it here, and it is said.
    assert.equal(page.prompt().value, 'la prise de la conversation 2');
    assert.deepEqual(body.find('studio-enrich')[0].find('studio-link'), [], 'no « Revenir à mon texte » either');
    assert.equal(notices.at(-1), 'Prompt non enrichi : la conversation ou le mode a changé entre-temps.');
    assert.equal(studio.busy(), false);
    // The first conversation comes back as it was left.
    conversation = 'c1';
    studio.conversationChanged();
    await settle();
    assert.equal(page.prompt().value, 'un chat roux');
    // Asked and answered in the same conversation and mode: written, as before.
    void body.find('studio-enrich-go')[0].onclick();
    await settle();
    answer({ prompt: 'Un chat roux, de près.' });
    await settle();
    assert.equal(page.prompt().value, 'Un chat roux, de près.');

    // A clip given to « Vidéo à suivre »; before its copy ends, the user is in Image, where a slot
    // has the same name (the image to modify).
    page.mode(1);
    assert.deepEqual(slots(), [['source-0', null], ['reference-0', null]]);
    body.find('studio-slot')[0].ondrop(event([{ name: 'danse.mp4', type: 'video/mp4' }]));
    page.mode(0);
    await settle();
    assert.deepEqual(slots(), [['source-0', null]], 'not the image to modify');
    assert.match(notices.at(-1), /^Vidéo gardée dans les références du projet, mais pas placée/);
    await body.find('studio-go')[0].onclick();
    await settle();
    assert.equal('source' in asked.findLast(([route]) => route === 'tools/action')[1].arguments, false);
    // Nor in another conversation.
    body.find('studio-slot')[0].ondrop(event([{ name: 'a.png', type: 'image/png' }]));
    conversation = 'c2';
    studio.conversationChanged();
    await settle();
    assert.deepEqual(slots(), [['source-0', null]]);
    // Given and copied with nothing changed meanwhile: in its slot.
    body.find('studio-slot')[0].ondrop(event([{ name: 'b.png', type: 'image/png' }]));
    await settle();
    assert.deepEqual(slots(), [['source-0', '/preview/b.png']]);
  } finally {
    restore();
  }
});

test('a creation looked at leaves with its conversation: the Studio kept is the one of before, its seed does not follow; a sound of the disk gives its address back with its place on the screen', async () => {
  let conversation = 'c1';
  const runs = lookRuns();
  const page = await studioPage(lookModels(), lookRoutes, { runs, project: () => 'p1', conversation: () => conversation });
  const { body, studio, restore } = page;
  const back = () => body.find('studio-look-back').length,
    seed = () => body.find('studio-seed')[0].children[1].value;
  try {
    page.mode(1);
    page.prompt().value = 'mon idée de vidéo';
    page.prompt().oninput();
    assert.equal(seed(), '');
    // The clip of another conversation is looked at: its settings and its very seed, a way back.
    studio.show(runs[0]);
    assert.equal(page.prompt().value, 'un renard court dans la neige');
    assert.equal(seed(), '777');
    assert.equal(back(), 1);
    // A conversation not begun, in the same project: the look is over, nothing of it follows.
    conversation = null;
    studio.conversationChanged();
    await settle();
    assert.equal(back(), 0);
    assert.equal(page.prompt().value, '');
    assert.equal(seed(), '', 'the seed of a take only looked at is not the one of the next takes');
    // The conversation left comes back as it was before the look.
    conversation = 'c1';
    studio.conversationChanged();
    await settle();
    assert.equal(body.dataset.mode, 'video');
    assert.equal(page.prompt().value, 'mon idée de vidéo');
    assert.equal(seed(), '');
    assert.equal(back(), 0);
    // The same when the page says « another conversation » for the one in hand (renamed in the fil).
    studio.show(runs[0]);
    assert.equal(back(), 1);
    studio.conversationChanged();
    await settle();
    assert.equal(page.prompt().value, 'mon idée de vidéo');
    assert.equal(seed(), '');
    assert.equal(back(), 0);
    assert.deepEqual(body.find('studio-frame-result'), [], 'the clip looked at left the screen');
  } finally {
    restore();
  }
  // A sound of the disk on the screen plays from an address made for it.
  const made = { id: 'new', conversationId: 'c1', workflowId: 'k', prompt: 'un phare', parameters: { width: 1024, height: 1024 }, outputs: [{ originalUrl: '/new.png', thumbUrl: '/new.jpg', take: 4 }] };
  const sounds = await studioPage(
    lookModels(),
    {
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => (sounds.runs.unshift(made), { id: 'j', state: 'done', record: made }),
    },
    { runs: [] },
  );
  const given = [],
    urls = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  let count = 0;
  URL.createObjectURL = () => 'blob:son' + ++count;
  URL.revokeObjectURL = address => given.push(address);
  try {
    const drop = async name => {
        dropOn(sounds, { files: [new File([Buffer.from('RIFF\x24\0\0\0WAVEfmt ', 'latin1')], name, { type: 'audio/wav' })], types: ['Files'] });
        await settle();
      },
      onScreen = () => sounds.body.find('studio-frame-result').map(shown => shown.src);
    await drop('pluie.wav');
    assert.equal(sounds.body.dataset.mode, 'audio');
    assert.deepEqual(onScreen(), ['blob:son1']);
    // Another one in its place: the address of the first is given back.
    await drop('vent.wav');
    assert.deepEqual(onScreen(), ['blob:son2']);
    assert.deepEqual(given, ['blob:son1']);
    // A take made in Image ends the look: the sound leaves the screen of Son with its address.
    sounds.mode(0);
    sounds.prompt().value = 'un phare';
    sounds.prompt().oninput();
    await sounds.body.find('studio-go')[0].onclick();
    await settle();
    assert.deepEqual(onScreen(), ['/new.png']);
    assert.deepEqual(given, ['blob:son1', 'blob:son2']);
    sounds.mode(2);
    assert.deepEqual(onScreen(), [], 'no player left on an address given back');
  } finally {
    Object.assign(URL, { createObjectURL: urls.create, revokeObjectURL: urls.revoke });
    sounds.restore();
  }
});

test('a proposal made with a model of another family shelves the LoRAs of the family left; they come back with their model', async () => {
  const krea = { id: 'k', name: 'Krea 2', verb: 'create_image', family: 'krea2', styled: true, seeded: true, direct: true, roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] },
    moss = { ...krea, id: 'm', name: 'MOSS Image', family: 'moss' };
  const page = await studioPage(
    { create_image: [krea, moss] },
    { 'tools/action': () => ({ requestId: 'h', plan: { parameters: {} } }), 'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }) },
  );
  const { body, studio, asked, restore } = page;
  const loras = () => body.find('studio-lora-pick').map(pick => pick.value),
    byHand = async () => {
      await body.find('studio-go')[0].onclick();
      await settle();
      const [, action] = asked.findLast(([route]) => route === 'tools/action');
      return [action.arguments.workflow, action.styles ?? []];
    };
  try {
    // A LoRA made for Krea 2, added by hand.
    body.find('studio-lora-plus')[0].onclick();
    assert.deepEqual(loras(), ['a.safetensors']);
    // Moodix AI proposes an image with MOSS Image.
    const answer = studio.propose(
      {
        requestId: 'q',
        approvalToken: 't',
        tool: 'create_image',
        workflowName: 'MOSS Image',
        resolution: { width: 1024, height: 1024 },
        call: { id: 'call', type: 'function', function: { name: 'create_image', arguments: '{}' } },
        plan: { prompt: 'un phare', parameters: { prompt: 'un phare', width: 1024, height: 1024, seed: 3 }, editable: { prompt: true, parameters: [] }, references: [] },
      },
      new AbortController().signal,
    );
    await settle();
    assert.equal(body.find('studio-model-pick')[0].value, 'm');
    await body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    await studio.settled({ record: null });
    // The Studio stays on MOSS Image, without the LoRA of the other family: none goes with it.
    assert.equal(body.find('studio-model-pick')[0].value, 'm');
    assert.deepEqual(loras(), []);
    assert.deepEqual(await byHand(), ['m', []]);
    // Krea 2 chosen again: its LoRA is back.
    const pick = body.find('studio-model-pick')[0];
    pick.value = 'k';
    pick.onchange();
    assert.deepEqual(loras(), ['a.safetensors']);
    assert.deepEqual(await byHand(), ['k', [{ name: 'a.safetensors', strength: 1 }]]);
  } finally {
    restore();
  }
});

test('a proposal whose model has a fixed length keeps it: the length left by another model is no change of the user', async () => {
  const { clip, request } = proposalOf({ frames: 241 });
  // Its length is « Fixe » in Configuration › Workflows: no list of lengths, no bar; the server
  // still lists `frames` among what the user may change on the card (editableParameters).
  const fixed = { ...clip, id: 'b', lengths: undefined },
    free = { ...clip, id: 'a', name: 'Libre' };
  const sent = [];
  const page = await studioPage({ create_video: [free, fixed] }, { 'tools/revise': ({ edits }) => (sent.push(edits), { requestId: 'q2', approvalToken: 't2' }) });
  const { body, studio, restore } = page;
  const duration = () => body.find('studio-bar').filter(bar => bar.dataset.ai === 'duration');
  try {
    // Vidéo was shown with the other model: its length (05.04 S) is in the draft.
    page.mode(1);
    assert.equal(duration()[0].attributes['aria-valuetext'], '05.04 S');
    const answer = studio.propose(request, new AbortController().signal);
    await settle();
    assert.equal(body.find('studio-model-pick')[0].value, 'b');
    assert.deepEqual(duration(), [], 'no length to set');
    // Nothing touched: nothing is sent, the 241 frames proposed are made.
    await body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    assert.deepEqual(sent, []);
  } finally {
    restore();
  }
});

test('while a character waits for its check, « Générer » from another mode is no answer: the question comes back', async () => {
  const { tools } = continuing(),
    runs = [{ id: 'made', conversationId: 'c1', workflowId: 'k', prompt: 'A full-length photo of a player', parameters: {}, outputs: [{ originalUrl: '/made.png', thumbUrl: '/made.jpg' }] }];
  const page = await studioPage(tools, { 'tools/action': () => ({ requestId: 'h', plan: { parameters: {} } }) }, { runs });
  const { body, studio, notices, asked, restore } = page;
  try {
    let answered = null;
    const check = studio.checkCharacter(runs[0], new AbortController().signal);
    void check.then(answer => (answered = answer));
    await settle();
    assert.equal(body.find('studio-check-question').length, 1);
    // The user goes to Vidéo: no question there, the button reads « Générer ».
    page.mode(1);
    assert.equal(body.find('studio-check-question').length, 0);
    assert.equal(body.find('studio-go-label')[0].textContent, 'Générer');
    page.prompt().value = 'une mouette au-dessus du port';
    page.prompt().oninput();
    await body.find('studio-go')[0].onclick();
    await settle();
    // Not taken for « OK », and nothing generated: the question is back, in Image.
    assert.equal(answered, null);
    assert.equal(asked.filter(([route]) => route === 'tools/action').length, 0);
    assert.equal(body.dataset.mode, 'image');
    assert.equal(body.find('studio-check-question').length, 1);
    assert.equal(notices.at(-1), 'Ce personnage vous convient ? Répondez d’abord : OK, Autre image ou Annuler.');
    // There, « OK » (the same button) keeps the character.
    await body.find('studio-go')[0].onclick();
    assert.deepEqual((await check).decision, 'ok');
  } finally {
    restore();
  }
});

test('« Modifier » chooses a model that takes an image when the one in hand takes none; held while Moodix AI proposes an image', async () => {
  const moss = { id: 'm', name: 'MOSS Image', verb: 'create_image', family: 'moss', direct: true, roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] },
    krea = { ...moss, id: 'k', name: 'Krea 2', family: 'krea2', roles: { source: { count: 1, media: ['image'] } } },
    runs = [{ id: 'fox', conversationId: 'c1', workflowId: 'x', prompt: 'un renard', parameters: {}, outputs: [{ originalUrl: '/fox.png', thumbUrl: '/fox.jpg', take: 3 }] }];
  const page = await studioPage({ create_image: [moss, krea] }, {}, { runs });
  const { body, studio, notices, restore } = page;
  const modify = () => {
      body.find('studio-item')[0].oncontextmenu({ preventDefault() {} });
      return body.find('studio-menu-item').find(item => item.children.at(-1).textContent === 'Modifier');
    },
    slots = () => body.find('studio-slot').map(tile => tile.children[0].children[0]?.src ?? null);
  try {
    // MOSS Image is in hand: it takes no image. Krea 2 does.
    assert.equal(body.find('studio-model-pick')[0].value, 'm');
    assert.deepEqual(slots(), []);
    modify().onclick();
    // The model that takes it is chosen, the image is in its slot.
    assert.equal(body.find('studio-model-pick')[0].value, 'k');
    assert.deepEqual(slots(), ['/fox.jpg']);
    // While Moodix AI proposes an image, the slots are those of its proposal: held, and said.
    const answer = studio.propose(
      {
        requestId: 'q',
        approvalToken: 't',
        tool: 'create_image',
        workflowName: 'Krea 2',
        resolution: { width: 1024, height: 1024 },
        call: { id: 'call', type: 'function', function: { name: 'create_image', arguments: '{}' } },
        plan: { prompt: 'un phare', parameters: { prompt: 'un phare', width: 1024, height: 1024, seed: 3 }, editable: { prompt: true, parameters: [] }, references: [] },
      },
      new AbortController().signal,
    );
    await settle();
    assert.deepEqual(slots(), [null], 'the slots of the proposal: it has no image');
    const held = modify();
    assert.equal(held.attributes['aria-disabled'], 'true');
    held.onclick();
    assert.equal(notices.at(-1), 'Moodix AI est en train de proposer');
    assert.deepEqual(slots(), [null]);
    studio.decline();
    assert.equal(await answer, 'deny');
  } finally {
    restore();
  }
  // No model takes an image to modify: « Modifier » is not offered.
  const alone = await studioPage({ create_image: [moss] }, {}, { runs });
  try {
    alone.body.find('studio-item')[0].oncontextmenu({ preventDefault() {} });
    assert.deepEqual(
      alone.body.find('studio-menu-item').map(item => item.children.at(-1).textContent),
      ['Détails', 'Supprimer'],
    );
  } finally {
    alone.restore();
  }
});
