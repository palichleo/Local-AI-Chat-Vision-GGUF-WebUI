import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolCatalog } from '../lib/tool-catalog.mjs';
import { ToolRuntime, collectToolCalls } from '../lib/tool-runtime.mjs';
import { MAX_CALL_ARGUMENTS, nativeFields } from '../lib/native-messages.mjs';
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
  // Asked for by the user: every image runs by itself, in the Studio too, whatever the settings say
  // (« lancer seules les images » is off in this world).
  assert.equal(first.autoAllow, true);
  // The call of the model is kept as it was asked (the conversation shows it).
  assert.deepEqual(JSON.parse(first.call.function.arguments).series, prompts.slice(1));

  const second = await runtime.next({ series: first.series.id });
  assert.deepEqual([second.series.index, second.series.total], [2, 3]);
  assert.ok(second.plan.prompt.includes(prompts[1]));
  assert.equal(second.call.id, first.call.id, 'one call of the model, one result for it');
  assert.equal(second.args.workflow_id, first.args.workflow_id, 'the same workflow and settings');
  assert.equal(second.autoAllow, true);
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

test('the first image listed again at the head of the others is made once (0.6.91)', async () => {
  // The local model, asked for five images, sent its prompt then all five in `series`: six were made,
  // the first one twice.
  const prompts = [
    'A vast cosmic nebula of pink and purple clouds lit by distant blue stars, wide view.',
    'A silver space shuttle rising through a twilight sky, its engines glowing orange.',
    'A glowing blue planet with white clouds and rings of ice, against deep space.',
    'An astronaut in a white suit standing at the edge of a crater, seen from behind.',
    'A spiral galaxy of yellow and white stars among dark lanes of dust.',
  ];
  const ask = (runtime, args) => runtime.request([call('create_image', args)], { conversationId: A, turnId: turn, messages: [] });
  const { runtime } = world();
  const listed = await ask(runtime, { prompt: prompts[0], series: [` ${prompts[0]} `, ...prompts.slice(1)] });
  assert.deepEqual([listed.series.index, listed.series.total], [1, 5], 'five images, as asked');
  // The call the conversation keeps says the images made: the page counts them from it.
  assert.deepEqual(JSON.parse(listed.call.function.arguments).series, prompts.slice(1));
  const second = await runtime.next({ series: listed.series.id });
  assert.ok(second.plan.prompt.includes(prompts[1]), 'the second image is the second prompt, not the first again');
  // The same image asked several times over is left as it was asked: three of it.
  const same = await ask(world().runtime, { prompt: prompts[0], series: [prompts[0], prompts[0]] });
  assert.equal(same.series.total, 3);
  assert.equal(JSON.parse(same.call.function.arguments).series.length, 2);
  // And two of one image: nothing says the second is a repeat.
  const pair = await ask(world().runtime, { prompt: prompts[0], series: [prompts[0]] });
  assert.equal(pair.series.total, 2);
  // A series written as it should be is untouched.
  const right = await ask(world().runtime, { prompt: prompts[0], series: prompts.slice(1) });
  assert.equal(right.series.total, 5);
});

test('a call of twenty prompts fits in the stream and in the history', () => {
  const prompt = 'A detailed watercolour of a lighthouse on a cliff at dawn, seen from the sea, '.repeat(30);
  const args = JSON.stringify({ prompt, series: Array(19).fill(prompt) });
  assert.ok(args.length > 16000);
  const calls = [];
  collectToolCalls(calls, { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'create_image', arguments: args } }] });
  assert.doesNotThrow(() => nativeFields({ role: 'assistant', tool_calls: calls }));
});

test('the largest call the tool allows is not cut in its stream, nor refused when the conversation is read again', async () => {
  // What the schema of create_image allows (lib/tasks.json): a prompt of 8 000 characters and
  // nineteen others of 3 000, 65 000 in all: more than the 64 000 a call could hold.
  const definition = (await new ToolCatalog({ list: async () => shipped() }).definitions()).find(
    tool => tool.function.name === 'create_image',
  ).function.parameters.properties;
  const series = definition.series;
  assert.deepEqual([definition.prompt.maxLength, series.maxItems, series.items.maxLength], [8000, 19, 3000]);
  const text = length => 'A lighthouse, "seen" from the sea.\n'.repeat(Math.ceil(length / 35)).slice(0, length);
  const largest = {
    prompt: text(definition.prompt.maxLength),
    series: Array(series.maxItems).fill(text(series.items.maxLength)),
    source: { resource: uid(7) },
    format: '16:9',
  };
  const args = JSON.stringify(largest);
  assert.ok(args.length > 65000, 'with its quotes and line ends written as JSON does');
  assert.ok(args.length <= MAX_CALL_ARGUMENTS);
  // Streamed in pieces, as a model writes it.
  const calls = [];
  for (let at = 0; at < args.length; at += 4000)
    collectToolCalls(calls, {
      tool_calls: [{ index: 0, ...(at ? {} : { id: 'call_1' }), function: { ...(at ? {} : { name: 'create_image' }), arguments: args.slice(at, at + 4000) } }],
    });
  assert.equal(calls[0].function.arguments, args);
  assert.doesNotThrow(() => nativeFields({ role: 'assistant', tool_calls: calls }));
  // Proposed as any series (its prompts are within what a prompt may be).
  const { runtime } = world();
  const { source, format, ...asked } = largest;
  const first = await runtime.request([call('create_image', asked)], { conversationId: A, turnId: turn, messages: [] });
  assert.deepEqual([first.series.index, first.series.total], [1, 20]);
  // Beyond the limit, a call is still stopped: in its stream, and when the conversation is read.
  const beyond = JSON.stringify({ prompt: 'x'.repeat(MAX_CALL_ARGUMENTS) });
  assert.throws(
    () => collectToolCalls([], { tool_calls: [{ index: 0, id: 'c', function: { name: 'create_image', arguments: beyond } }] }),
    /trop longs/,
  );
  assert.throws(
    () => nativeFields({ role: 'assistant', tool_calls: [{ id: 'c', type: 'function', function: { name: 'create_image', arguments: beyond } }] }),
    /invalide/,
  );
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
  const { runSeries, seriesContent, SERIES_MADE } = await import('../public/image-series.mjs');
  const { asked, cards, options } = page([() => made(13, 'A whale.', 2), () => made(14, 'An owl.', 3)]);
  // What the page is given to keep in the conversation after each image but the last, with the
  // cards on screen at that time.
  const keeps = [];
  options.keep = async content => keeps.push([cards.length, JSON.parse(content)]);
  const result = await runSeries(request, made(12, 'A fox.', 1), options);
  // (Made to its last image: the server has let the series go by itself, nothing more is said.)
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
    told.images.map(image => [image.takes[0], image.seed, image.status]),
    [
      [12, 1, 'success'],
      [13, 2, 'success'],
      [14, 3, 'success'],
    ],
  );
  // The prompts are in the call already, in this order: not written a second time in its result.
  assert.equal(JSON.stringify(told).includes('A whale.'), false);
  assert.equal(told.images.some(image => 'prompt' in image) || 'prompt' in told, false);
  // The images are not handed to the model by themselves: it is told so, and how to look at one.
  assert.equal(told.note, SERIES_MADE);
  assert.match(SERIES_MADE, /Tu ne les as pas vues/);
  assert.match(SERIES_MADE, /une image à la fois avec local_read_output/);
  // After the first image and after the second, before the next is asked for: what is made so far,
  // as a series left unfinished would be read (the application closed between two images).
  assert.deepEqual(
    keeps.map(([shown, kept]) => [shown, kept.status, kept.made, kept.asked, kept.takes, kept.images.map(image => image.run_id)]),
    [
      [0, 'partial', 1, 3, [12], ['run-12']],
      [1, 'partial', 2, 3, [12, 13], ['run-12', 'run-13']],
    ],
  );
  assert.match(keeps[1][1].message, /^Série interrompue avant sa fin : 2 images sur 3 ont été faites\.$/);
  assert.match(keeps[0][1].message, /1 image sur 3 a été faite/);
  assert.match(keeps[1][1].note, /Ne refais jamais celles qui existent/);
  assert.equal(told.workflow, 'Z-Image');
  assert.equal('seed' in told.parameters, false, 'the seed is each image’s own');
  // Each image keeps its identifier: the conversation reopened shows them all again by it (left
  // out, the message came back empty), and the line of an interrupted creation is not written.
  assert.deepEqual(told.images.map(image => image.run_id), ['run-12', 'run-13', 'run-14']);
  assert.equal(told.run_id, undefined);
  const { callNote } = await import('../public/transcript.mjs');
  const call = { id: 'call-1', type: 'function', function: { name: 'create_image', arguments: '{}' } };
  assert.equal(callNote(call, { role: 'tool', tool_call_id: 'call-1', content: result.content }), '');
  assert.equal(result.stopped, false);
  // A large model reads its facts: no identifier.
  const facts = JSON.parse(capableResult(result.content));
  assert.equal('use_as_source' in facts || 'workflow_id' in facts || 'takes_note' in facts, false);
  assert.equal(JSON.parse(seriesContent([made(1, 'x', 1).content], 1)).status, 'success');
});

test('its last image made, then the chat model not back on the card: every image counted, nothing « stopped » (0.6.99)', async () => {
  const { runSeries } = await import('../public/image-series.mjs');
  // What the page gets when the take is saved and the model does not come back within its 5 minutes.
  const late = { ...made(14, 'An owl.', 3), failed: true, error: 'Le modèle n’a pas redémarré.' };
  late.content = JSON.stringify({ ...JSON.parse(late.content), status: 'generated' });
  const { asked, options } = page([() => made(13, 'A whale.', 2), () => late]);
  const result = await runSeries(request, made(12, 'A fox.', 1), options);
  const told = JSON.parse(result.content);
  assert.deepEqual([told.status, told.made, told.asked], ['success', 3, 3]);
  assert.deepEqual(told.images.map(image => image.run_id), ['run-12', 'run-13', 'run-14']);
  // « L’image 3 est faite, mais une erreur a suivi (…) : la série s’arrête là. » under three images made
  // sent the user to make them again.
  assert.equal(told.message, undefined);
  assert.deepEqual([result.stopped, result.failed, result.late], [false, false, 'Le modèle n’a pas redémarré.']);
  assert.equal(result.record.id, 'run-14');
  assert.equal(asked.some(([, body]) => body.end), false, 'the server ended the series with its last image');
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
  // No other image is asked for after the failure; the server is told the series is over (it lets
  // its prompts go and brings the chat model back), and the page waits for its answer.
  assert.deepEqual(asked, [
    ['tools/series', { series: 's1' }],
    ['tools/series', { series: 's1', end: true }],
  ]);
  assert.deepEqual([told.status, told.made, told.takes], ['partial', 1, [12]]);
  assert.match(told.message, /image 2 a échoué/);
  // Not the note of a single failed image (« rien n’a été produit », then « refais le même appel »):
  // it would have the images already made done again.
  assert.match(told.note, /^Série incomplète : 1 image sur 3 est faite et montrée à l’utilisateur/);
  assert.match(told.note, /Ne refais jamais celles qui existent/);
  assert.equal(result.failed, false, 'what was made stays: the turn goes on');
  assert.equal(result.stopped, true, 'and the model does not call again in this message');

  ({ asked, options } = page([() => ({ content: '{"status":"denied"}', images: [], denied: true })]));
  told = JSON.parse((await runSeries(request, made(12, 'A fox.', 1), options)).content);
  assert.match(told.message, /image 2 a été refusée/);
  assert.deepEqual(asked.at(-1), ['tools/series', { series: 's1', end: true }]);

  // An image made, then an error (its copy for the model, the hand-back of the card): it is one of
  // the images made and shown, as the count says. It was said to have « failed », while counted.
  const flawed = { ...made(13, 'A whale.', 2), failed: true, error: 'Copie pour l’analyse indisponible.' };
  flawed.content = JSON.stringify({ ...JSON.parse(flawed.content), status: 'generated', warning: flawed.error });
  ({ asked, options } = page([() => flawed, () => made(14, 'An owl.', 3)]));
  result = await runSeries(request, made(12, 'A fox.', 1), options);
  told = JSON.parse(result.content);
  assert.deepEqual([told.status, told.made, told.takes], ['partial', 2, [12, 13]]);
  assert.equal(told.message, 'L’image 2 est faite, mais une erreur a suivi (Copie pour l’analyse indisponible) : la série s’arrête là.');
  assert.deepEqual([result.record.id, result.images.length, result.stopped, result.failed], ['run-13', 2, true, false]);
  assert.match(told.note, /^Série incomplète : 2 images sur 3 sont faites et montrées/);
  assert.equal(asked.filter(([, body]) => !body.end).length, 1, 'the third image is not asked for');

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
  // Asked for the rest later, the model makes the images that are missing, not those that exist.
  assert.match(told.note, /^Série incomplète : 2 images sur 3 .*Ne refais jamais celles qui existent/);
  // The server is told there too, without the turn waiting for it; a page that cannot keep the
  // conversation does not stop the series (it says so itself).
  assert.deepEqual(stopped.asked.at(-1), ['tools/series', { series: 's1', end: true }]);
  const unsaved = page([() => made(13, 'A whale.', 2), () => made(14, 'An owl.', 3)]);
  unsaved.options.keep = async () => {
    throw Error('disque plein');
  };
  assert.equal(JSON.parse((await runSeries(request, made(12, 'A fox.', 1), unsaved.options)).content).made, 3);
});
