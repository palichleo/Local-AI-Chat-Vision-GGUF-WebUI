import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolCatalog } from '../lib/tool-catalog.mjs';
import { ToolRuntime, collectToolCalls } from '../lib/tool-runtime.mjs';
import { nativeFields } from '../lib/native-messages.mjs';
import { resolveNativeWorkflow, validateNativeWorkflow } from '../lib/native-workflows.mjs';
import { CAPABLE, CAPABLE_SYSTEM, capableResult } from '../lib/model-wording.mjs';

/**
 * Several images asked in one message (« fais 10 images de ce style », 17/11): the model prepares
 * every prompt in one call of create_image (`series`), Moodix makes them one after another with the
 * same inputs and settings, without asking the model between two, and gives it one result for all.
 */
const folder = fileURLToPath(new URL('../runner/workflows/', import.meta.url));
const shipped = () =>
  readdirSync(folder)
    .filter(name => name.endsWith('.json'))
    .map(name => ({ ...validateNativeWorkflow(JSON.parse(readFileSync(join(folder, name), 'utf8'))), ready: true }));
const assets = { resolve: async id => ({ id, path: join(tmpdir(), `${id}.safetensors`) }) };
const uid = n => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const call = (name, args, id = 'call-1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const A = uid(1),
  turn = uid(2);

function world() {
  const workflows = shipped();
  const engine = { busy: false, state: 'ready', stop: async () => {}, start: async () => {} };
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
    gallery: { get: async () => Promise.reject(Object.assign(Error('absent'), { status: 404 })), put: async r => r },
    resources: { activeRecord: async () => Promise.reject(Object.assign(Error('absent'), { status: 404 })) },
    getConfig: () => ({ enabled: true, autoAllow: false, maxIterations: 50, baseUrl: 'native' }),
    engineConfig: () => ({}),
    clientFactory: () => null,
    sourceMedia: async () => ({ mime: 'image/png', name: 'x', handle: { close: async () => {} } }),
  });
  return { runtime, workflows };
}

test('create_image takes the prompts of the other images (series), for the local model and the large ones', async () => {
  const tools = new ToolCatalog({ list: async () => shipped() });
  for (const wording of [undefined, CAPABLE]) {
    const definitions = Object.fromEntries(
      (await tools.definitions(undefined, wording ? { wording } : undefined)).map(tool => [tool.function.name, tool.function]),
    );
    const series = definitions.create_image.parameters.properties.series;
    assert.equal(series.type, 'array');
    assert.deepEqual([series.minItems, series.maxItems, series.items.type], [1, 19, 'string']);
    assert.match(series.description, /several images/);
    assert.equal(definitions.create_image.parameters.required.includes('series'), false, 'one image needs none');
    assert.equal('series' in definitions.create_video.parameters.properties, false);
  }
  // Told to the large models: one call for several images, not « one creation per message ».
  assert.doesNotMatch(CAPABLE_SYSTEM, /One creation per message/);
  assert.match(CAPABLE_SYSTEM, /several images/);
});

test('several images in one call: the first proposed at once, the others one after another with their own prompt', async () => {
  const { runtime } = world();
  const prompts = [
    'A red fox in fresh snow, loose watercolour, soft morning light.',
    'A blue whale at dusk under a pink sky, loose watercolour.',
    'A barn owl on a mossy branch at night, loose watercolour.',
  ];
  const first = await runtime.request([call('create_image', { prompt: prompts[0], series: prompts.slice(1) })], {
    conversationId: A,
    turnId: turn,
    messages: [],
  });
  assert.deepEqual([first.series.index, first.series.total], [1, 3]);
  assert.ok(first.plan.prompt.includes(prompts[0]));
  // The call of the model is kept as it was asked (the conversation shows it).
  assert.deepEqual(JSON.parse(first.call.function.arguments).series, prompts.slice(1));

  const second = await runtime.next({ series: first.series.id });
  assert.deepEqual([second.series.index, second.series.total], [2, 3]);
  assert.ok(second.plan.prompt.includes(prompts[1]));
  assert.equal(second.call.id, first.call.id, 'one call of the model, one result for it');
  assert.equal(second.args.workflow_id, first.args.workflow_id, 'the same workflow and settings');
  assert.notEqual(second.requestId, first.requestId);
  const third = await runtime.next({ series: first.series.id });
  assert.ok(third.plan.prompt.includes(prompts[2]));
  await assert.rejects(runtime.next({ series: first.series.id }), /terminée/);
});

test('a series is only for images, of 1 to 19 prompts after the first, each a text', async () => {
  const { runtime } = world();
  const ask = args => runtime.request([call('create_image', args)], { conversationId: A, turnId: turn, messages: [] });
  await assert.rejects(ask({ prompt: 'A cat.', series: [] }), /series/);
  await assert.rejects(ask({ prompt: 'A cat.', series: Array(20).fill('A dog.') }), /series/);
  await assert.rejects(ask({ prompt: 'A cat.', series: ['A dog.', ''] }), /series/);
  await assert.rejects(ask({ prompt: 'A cat.', series: 'A dog.' }), /series/);
  await assert.rejects(
    runtime.request([call('create_video', { prompt: 'A cat walks.', intention: 'x', duration: null, series: ['y'] })], {
      conversationId: A,
      turnId: turn,
      messages: [],
    }),
    /images/,
  );
});

test('a call of twenty prompts fits in the stream and in the history', () => {
  const prompt = 'A detailed watercolour of a lighthouse on a cliff at dawn, seen from the sea, '.repeat(30);
  const args = JSON.stringify({ prompt, series: Array(19).fill(prompt) });
  assert.ok(args.length > 16000);
  const calls = [];
  collectToolCalls(calls, { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'create_image', arguments: args } }] });
  assert.doesNotThrow(() => nativeFields({ role: 'assistant', tool_calls: calls }));
});

// ——— La page : les images après la première, une par une ———

const made = (take, prompt, seed) => ({
  content: JSON.stringify({
    status: 'success',
    run_id: `run-${take}`,
    takes: [take],
    takes_note: 'Pour l’utilisateur, ces prises s’appellent « PRISE n ».',
    use_as_source: { output: `run-${take}` },
    workflow: 'Z-Image',
    prompt,
    workflow_id: 'z',
    media_type: 'image',
    parameters: { seed, width: 1024, height: 1024 },
  }),
  images: [`data:image/png;base64,${take}`],
  record: { id: `run-${take}` },
});
/** The page as runSeries uses it: the server's next proposals, the cards, the runs. */
function page(outcomes) {
  const asked = [],
    cards = [];
  let at = 1;
  return {
    asked,
    cards,
    options: {
      api: async (path, body) => {
        asked.push([path, body]);
        at++;
        return Response.json({ requestId: `r${at}`, series: { id: body.series, index: at, total: 3 } });
      },
      signal: new AbortController().signal,
      mount: proposal => {
        const card = { proposal, finished: null, withdrawn: false, failure: '' };
        card.finish = result => (card.finished = result);
        card.withdraw = () => (card.withdrawn = true);
        card.failed = message => (card.failure = message);
        cards.push(card);
        return card;
      },
      run: async proposal => {
        const outcome = outcomes.shift();
        if (outcome instanceof Error) throw outcome;
        return outcome(proposal);
      },
    },
  };
}
const request = { call: { id: 'call-1' }, series: { id: 's1', index: 1, total: 3 } };

test('the images of a series one after another, then one result for the call: every take, said once', async () => {
  const { runSeries, seriesContent } = await import('../public/image-series.mjs');
  const { asked, cards, options } = page([() => made(13, 'A whale.', 2), () => made(14, 'An owl.', 3)]);
  const result = await runSeries(request, made(12, 'A fox.', 1), options);
  assert.deepEqual(asked, [
    ['tools/series', { series: 's1' }],
    ['tools/series', { series: 's1' }],
  ]);
  assert.equal(cards.length, 2, 'a card for each image after the first');
  assert.ok(cards.every(card => card.finished));
  assert.deepEqual(result.images.length, 3);
  assert.equal(result.record.id, 'run-14');
  const told = JSON.parse(result.content);
  assert.deepEqual([told.status, told.made, told.asked, told.takes], ['success', 3, 3, [12, 13, 14]]);
  assert.deepEqual(
    told.images.map(image => [image.takes[0], image.prompt, image.seed]),
    [
      [12, 'A fox.', 1],
      [13, 'A whale.', 2],
      [14, 'An owl.', 3],
    ],
  );
  assert.equal(told.workflow, 'Z-Image');
  assert.equal('seed' in told.parameters, false, 'the seed is each image’s own');
  // A large model reads its facts: no identifier.
  const facts = JSON.parse(capableResult(result.content));
  assert.equal('use_as_source' in facts || 'workflow_id' in facts || 'takes_note' in facts, false);
  assert.equal(JSON.parse(seriesContent([made(1, 'x', 1).content], 1)).status, 'success');
});

test('a series stops at an image refused or failed; stopped by the user, the call says what was made', async () => {
  const { runSeries } = await import('../public/image-series.mjs');
  const failed = {
    content: JSON.stringify({ status: 'error', message: 'Mémoire vidéo insuffisante.', note: 'settled later' }),
    images: [],
    failed: true,
  };
  let { asked, options } = page([() => failed, () => made(14, 'An owl.', 3)]);
  let result = await runSeries(request, made(12, 'A fox.', 1), options);
  let told = JSON.parse(result.content);
  assert.equal(asked.length, 1, 'nothing asked after the failure');
  assert.deepEqual([told.status, told.made, told.takes], ['partial', 1, [12]]);
  assert.match(told.message, /image 2 a échoué/);
  assert.equal(told.note, 'settled later');
  assert.equal(result.failed, false, 'what was made stays: the turn goes on');

  ({ asked, options } = page([() => ({ content: '{"status":"denied"}', images: [], denied: true })]));
  told = JSON.parse((await runSeries(request, made(12, 'A fox.', 1), options)).content);
  assert.match(told.message, /image 2 a été refusée/);

  const stop = new AbortController();
  const stopped = page([
    () => made(13, 'A whale.', 2),
    Object.assign(new Error('arrêté'), { name: 'AbortError' }),
  ]);
  const run = stopped.options.run;
  stopped.options.signal = stop.signal;
  stopped.options.run = async proposal => {
    if (proposal.series.index === 3) stop.abort();
    return run(proposal);
  };
  const error = await runSeries(request, made(12, 'A fox.', 1), stopped.options).catch(error => error);
  assert.ok(stopped.cards.at(-1).withdrawn, 'the card of the image stopped goes');
  told = JSON.parse(error.series);
  assert.deepEqual([told.status, told.made, told.takes], ['partial', 2, [12, 13]]);
  assert.match(told.message, /arrêtée par l’utilisateur : 2 images sur 3/);
});
