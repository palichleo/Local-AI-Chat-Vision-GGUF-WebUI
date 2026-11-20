import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resources } from '../lib/resources.mjs';
import { takesToOutputs } from '../lib/takes.mjs';
import { ToolCatalog, STILL_FRAMES, imageRoles } from '../lib/tool-catalog.mjs';
import { CAPABLE } from '../lib/model-wording.mjs';
import { validateNativeWorkflow } from '../lib/native-workflows.mjs';
import { extractStill, STILLS } from '../lib/video-still.mjs';
import { runEnvironmentCommand } from '../lib/python-environment.mjs';
import { GenerationService } from '../lib/generation-service.mjs';
import { imageSize } from '../lib/image-size.mjs';

/**
 * The first or last image of a video used as an image (`frame`: "first" or "last"): what the
 * server does around the proposal (tests/tool-proposals.mjs has the proposal itself): the take
 * named by its number, the reference kept, the command that reads the picture, the definitions.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const DOT =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rLkAAAAASUVORK5CYII=';
const PNG = Buffer.from(DOT.split(',')[1], 'base64');
const uid = n => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
async function folder(t) {
  const path = await mkdtemp(join(tmpdir(), 'atelier-still-'));
  assert.equal(dirname(path), tmpdir());
  t.after(() => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return path;
}

test('a take named by its number keeps the frame asked of it: {"take": 25, "frame": "last"}', async () => {
  const [A, B, RUN, FAR] = [uid(1), uid(2), uid(3), uid(4)];
  let listed = 0;
  const takes = async () => {
    listed++;
    return [
      { take: 25, id: RUN, index: 0, conversationId: A, mediaType: 'video' },
      { take: 26, id: FAR, index: 1, conversationId: B, mediaType: 'video' },
    ];
  };
  const resolved = JSON.parse(
    await takesToOutputs(
      JSON.stringify({
        prompt: 'p',
        start_image: { take: 25, frame: 'last' },
        reference: [{ take: 26, frame: 'first' }, { image: 0 }],
      }),
      takes,
      A,
    ),
  );
  assert.deepEqual(resolved, {
    prompt: 'p',
    start_image: { frame: 'last', output: RUN },
    reference: [{ frame: 'first', output: FAR, index: 1, conversation: B }, { image: 0 }],
  });
  assert.equal(listed, 1);
  // No take named: the arguments as they were, the takes of the project not even read.
  const plain = '{"prompt":"p","start_image":{"output":"' + RUN + '","frame":"last"}}';
  assert.equal(await takesToOutputs(plain, takes, A), plain);
  assert.equal(await takesToOutputs('pas du JSON', takes, A), 'pas du JSON');
  assert.equal(listed, 1);
  await assert.rejects(takesToOutputs('{"start_image":{"take":9,"frame":"last"}}', takes, A), {
    status: 400,
    message: 'La prise 9 n’existe pas dans ce projet.',
  });
});

test('a picture the application made is an ordinary image reference of the project, found again by what it was taken from', async t => {
  const path = join(await folder(t), 'resources'),
    store = new Resources(path),
    [P, Q] = [uid(5), uid(6)],
    origin = `take/${uid(1)}/${uid(3)}/0/last`;
  const still = (extra = {}) => ({
    project: P,
    name: 'Dernière image · PRISE 25',
    origin,
    bytes: Buffer.concat([PNG, Buffer.from('last')]),
    preview: DOT,
    width: 1280,
    height: 720,
    ...extra,
  });
  assert.equal(await store.stillOf(P, origin), null);
  const kept = await store.keepStill(still());
  assert.deepEqual(
    [kept.label, kept.name, kept.mime, kept.width, kept.height, kept.ready, kept.enabled, kept.origin, kept.project],
    ['#ref1', 'Dernière image · PRISE 25', 'image/png', 1280, 720, true, true, origin, P],
  );
  // As any reference: in the list of the model, its file whole, its small copy for the page.
  assert.deepEqual((await store.catalog(P)).map(item => [item.label, item.type, item.width, item.height]), [['#ref1', 'image', 1280, 720]]);
  const original = await store.media(kept.id, 'original');
  try {
    assert.deepEqual(await original.handle.readFile(), still().bytes);
    assert.equal(original.path, join(path, kept.id, 'source.png'));
  } finally {
    await original.handle.close();
  }
  assert.equal((await store.readActive(kept.id)).frames[0].url, DOT);
  // Found again by its origin, in its project only, and after the application is started again.
  assert.equal((await store.stillOf(P, origin)).id, kept.id);
  assert.equal(await store.stillOf(Q, origin), null);
  assert.equal(await store.stillOf(P, origin.replace('last', 'first')), null);
  assert.equal((await new Resources(path).stillOf(P, origin)).id, kept.id);
  // The same picture kept twice is one reference (as a file sent twice), whatever it is taken from.
  const twin = await store.keepStill(still({ origin: 'resource/' + uid(7) + '/first', name: 'Première image · #ref4' }));
  assert.deepEqual([twin.id, twin.existing, twin.name], [kept.id, true, 'Dernière image · PRISE 25']);
  assert.equal((await store.list(P)).length, 1);
  // Switched off by the user, it is no longer the one to take; removed, it is none.
  await store.update(kept.id, { enabled: false });
  assert.equal(await store.stillOf(P, origin), null);
  await store.remove(kept.id);
  assert.equal(await store.stillOf(P, origin), null);
  // A copy that cannot be kept leaves nothing half-made; an origin is a short plain text.
  await assert.rejects(store.keepStill(still({ preview: 'data:image/png;base64,AAAA' })), /Copie visuelle invalide/);
  await assert.rejects(store.keepStill(still({ bytes: Buffer.from('not a picture') })), /format du fichier/);
  await assert.rejects(store.keepStill(still({ origin: 'deux mots' })), /Origine de ressource invalide/);
  assert.deepEqual(await store.list(P), []);
  assert.deepEqual((await readdir(path)).filter(name => name !== 'references.json'), []);
});

test('the picture is read by a command of the engine’s Python that ends: its arguments, its files, its failures', async t => {
  const work = join(await folder(t), 'runtime', 'tmp'),
    calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    const value = name => args[args.indexOf(name) + 1];
    await writeFile(value('--output'), PNG);
    await writeFile(value('--preview'), Buffer.from([255, 216, 255, 224]));
    return { stdout: '{}', stderr: '' };
  };
  const still = await extractStill({ python: 'python-of-the-engine', root, input: 'clip.mp4', at: 'last', workDir: work, env: { A: '1' }, run });
  assert.deepEqual([still.width, still.height], [1, 1]);
  assert.deepEqual(still.bytes, PNG);
  assert.equal(still.preview, 'data:image/jpeg;base64,' + Buffer.from([255, 216, 255, 224]).toString('base64'));
  const [{ command, args, options }] = calls;
  assert.equal(command, 'python-of-the-engine');
  // The application folder on the path, then the command of the runner (runner/__main__.py).
  assert.deepEqual(args.slice(0, 2), ['-s', '-c']);
  assert.match(args[2], /run_module\('runner'/);
  assert.equal(args[3], resolve(root));
  assert.deepEqual(args.slice(4, 9), ['frame', '--input', 'clip.mp4', '--at', 'last']);
  assert.equal(dirname(dirname(args[args.indexOf('--output') + 1])), work, 'written in a folder of the application');
  assert.deepEqual([options.env.A, options.env.PYTHONIOENCODING], ['1', 'utf-8']);
  assert.ok(options.signal instanceof AbortSignal, 'never waits for ever');
  assert.deepEqual(await readdir(work), [], 'nothing left behind');
  // Its failure: the last line it wrote, the reason in the user's words; nothing left either.
  const failing = async () => {
    throw Error('Traceback (most recent call last):\n  …\nCe fichier n’est pas une vidéo lisible.');
  };
  await assert.rejects(
    extractStill({ python: 'python', root, input: 'clip.mp4', at: 'first', workDir: work, run: failing }),
    { message: 'Ce fichier n’est pas une vidéo lisible.' },
  );
  assert.deepEqual(await readdir(work), []);
  // No Python of the engine (its environment not installed), one that is gone, another frame.
  await assert.rejects(extractStill({ python: '', root, input: 'clip.mp4', at: 'last', workDir: work, run }), /n’est pas installé/);
  await assert.rejects(extractStill({ python: 'python', root, input: 'clip.mp4', at: 'last', workDir: work }), /n’est pas installé/);
  await assert.rejects(
    extractStill({ python: join(work, 'no-python-here'), root, input: 'clip.mp4', at: 'last', workDir: work, run: runEnvironmentCommand }),
    /le Python du moteur de génération est introuvable/,
  );
  await assert.rejects(extractStill({ python: 'python', root, input: 'clip.mp4', at: 'middle', workDir: work, run }), /invalide/);
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(STILLS), STILL_FRAMES);
  // The application without its environment: said, nothing installed nor downloaded for it.
  const data = await folder(t);
  const service = new GenerationService({ root, dataDir: data, workflowDir: join(data, 'workflow'), outputDir: join(data, 'output') });
  await assert.rejects(service.videoStill('clip.mp4', 'last'), /l’environnement de génération n’est pas installé/);
  assert.deepEqual(await readdir(data), []);
});

test('a capable model is offered "first" and "last"; the local model keeps the frames 0 to 2 it had', async () => {
  const workflows = readdirSync(join(root, 'runner', 'workflows'))
    .filter(name => name.endsWith('.json'))
    .map(name => ({ ...validateNativeWorkflow(JSON.parse(readFileSync(join(root, 'runner', 'workflows', name), 'utf8'))), ready: true }));
  const catalog = new ToolCatalog({ list: async () => workflows }),
    tool = (tools, name) => tools.find(item => item.function.name === name).function;
  const capable = await catalog.definitions(undefined, { wording: CAPABLE });
  const video = tool(capable, 'create_video');
  for (const role of ['start_image', 'end_image'])
    assert.deepEqual(
      video.parameters.properties[role].properties.frame,
      { anyOf: [{ type: 'string', enum: ['first', 'last'] }, { type: 'integer', minimum: 0, maximum: 2 }] },
      role,
    );
  // On a take as on a reference: one schema for every source, the frame beside either.
  assert.deepEqual(Object.keys(video.parameters.properties.start_image.properties).slice(0, 3), ['take', 'ref', 'frame']);
  assert.ok(video.parameters.properties.reference.items.properties.frame.anyOf);
  assert.ok(tool(capable, 'create_image').parameters.properties.source.properties.frame.anyOf);
  assert.match(
    video.description,
    /"frame": "last" for the last image of a video take or reference \(to start a new clip where it ends\), "first" for its first; 0, 1 or 2 for a sample of a video reference/,
  );
  // The clip a continuation starts from is taken whole: no frame of it to name.
  assert.equal(tool(capable, 'extend_video').parameters.properties.source.properties.frame, undefined);
  assert.deepEqual(imageRoles('create_video'), ['start_image', 'end_image', 'reference']);
  // (0.6.152) The end image of a continuation is taken from the user's own hand only (the Studio, the
  // Bobine): a frame of a video may stand in for it there; it is never offered to a model (below).
  assert.deepEqual(imageRoles('extend_video'), ['reference', 'end_image']);
  assert.equal(tool(capable, 'extend_video').parameters.properties.end_image, undefined);
  // The local model: the definitions it had, with or without the list of what the project holds.
  const number = { type: 'integer', minimum: 0, maximum: 2, description: 'Frame of a video resource used as an image.' };
  const held = { images: 0, resources: [{ id: uid(1), type: 'video' }], outputs: [], takes: [{ take: 25, mediaType: 'video' }] };
  for (const local of [await catalog.definitions(), await catalog.definitions(held)]) {
    assert.doesNotMatch(JSON.stringify(local), /"first"|"last"/);
    const start = tool(local, 'create_video').parameters.properties.start_image,
      frames = (start.anyOf ?? [start]).map(variant => variant.properties.frame).filter(Boolean);
    assert.deepEqual(frames, [number]);
  }
});

// The Python of the generation engine, when this machine has it: the one named by ATELIER_PYTHON,
// else the environment of this copy of the application (data/runtime).
const python = [
  process.env.ATELIER_PYTHON,
  join(root, 'data', 'runtime', 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
].find(path => path && existsSync(path));

test(
  'a real clip: its last and its first pictures come out at its size, through the function the server uses',
  { skip: python ? false : 'the Python environment of the generation engine is not installed here', timeout: 120000 },
  async t => {
    const work = await folder(t),
      clip = join(work, 'clip.mp4'),
      env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
    // Ten frames of 96 × 64 from black to white, encoded on the processor (MPEG-4, ffmpeg's own encoder).
    const code = [
      'import sys, av, numpy as np',
      "target = av.open(sys.argv[1], 'w')",
      "stream = target.add_stream('mpeg4', rate=24)",
      "stream.width, stream.height, stream.pix_fmt = 96, 64, 'yuv420p'",
      'for index in range(10):',
      '    pixels = np.full((64, 96, 3), round(255 * index / 9), dtype=np.uint8)',
      "    for packet in stream.encode(av.VideoFrame.from_ndarray(pixels, format='rgb24')):",
      '        target.mux(packet)',
      'for packet in stream.encode():',
      '    target.mux(packet)',
      'target.close()',
    ].join('\n');
    await runEnvironmentCommand(python, ['-s', '-c', code, clip], { cwd: root, env });
    // As the server asks for it (GenerationService.videoStill), with this Python as the engine's.
    const data = join(work, 'data'),
      service = new GenerationService({ root, dataDir: data, workflowDir: join(data, 'workflow'), outputDir: join(data, 'output') });
    service.config.pythonPath = python;
    const started = performance.now();
    const last = await service.videoStill(clip, 'last');
    t.diagnostic(`last picture read in ${Math.round(performance.now() - started)} ms`);
    assert.deepEqual(await readdir(join(data, 'runtime', 'tmp')), []);
    const run = runEnvironmentCommand;
    const first = await extractStill({ python, root, input: clip, at: 'first', workDir: join(work, 'tmp'), env, run });
    for (const still of [last, first]) {
      assert.deepEqual([still.width, still.height], [96, 64]);
      assert.deepEqual(imageSize(still.bytes), { width: 96, height: 64 });
      assert.match(still.preview, /^data:image\/jpeg;base64,\/9j\//);
    }
    assert.notDeepEqual(last.bytes, first.bytes, 'two different pictures');
    assert.deepEqual(await readdir(join(work, 'tmp')), []);
    // What is not a video is refused in a sentence, not with a trace of the program.
    const text = join(work, 'notes.mp4');
    await writeFile(text, 'not a video');
    await assert.rejects(extractStill({ python, root, input: text, at: 'last', workDir: join(work, 'tmp'), env, run }), error => {
      assert.doesNotMatch(error.message, /Traceback|File "/);
      assert.ok(error.message.length > 3 && !error.message.includes('\n'));
      return true;
    });
  },
);
