import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  OUTPUT_FOLDERS,
  anotherName,
  creationName,
  freeName,
  modelSlug,
  outputFolder,
  outputName,
  outputPart,
} from '../lib/output-names.mjs';
import { generatedFile, generatedMedia } from '../lib/generated-media.mjs';
import { Gallery } from '../lib/gallery.mjs';
import { readFileInfo, stampRecord } from '../lib/media-info.mjs';
import { moveManifests } from '../lib/output-manifests.mjs';
import { createApplication } from '../server.mjs';

// A creation as every one was written before the three folders, and one as they are written now.
const OLD = { filename: '2ab764ea796d4bfabefc92270fdd3729.png', subfolder: '', type: 'output' },
  NEW = { filename: '2026-11-17_14-32-05_krea-2_a3f9.png', subfolder: 'image', type: 'output' };
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rLkAAAAASUVORK5CYII=',
  'base64',
);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
// Where a record must never say its file is: above, deeper, elsewhere, or a folder that is none of the three.
const FOREIGN = ['..', '../image', 'image/..', 'a/b', 'image/2026', 'C:\\Windows', '/etc', 'C:', 'autre', 'Image', 'image ', 'sons'];

async function folder(t, prefix = 'moodix-output-') {
  const path = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
/** A folder of outputs holding one creation of each form, and a file that is no creation's. */
async function outputs(root) {
  const output = join(root, 'output');
  await mkdir(join(output, 'image'), { recursive: true });
  await writeFile(join(output, OLD.filename), png);
  await writeFile(join(output, 'image', NEW.filename), png);
  await writeFile(join(root, 'secret.png'), png);
  return output;
}
const record = (source, overrides = {}) => ({
  id: randomUUID(),
  conversationId: randomUUID(),
  provider: 'native',
  workflowId: 'krea',
  workflowName: 'Krea 2',
  prompt: 'Un renard',
  parameters: { seed: 7 },
  createdAt: '2026-11-17T13:32:05.000Z',
  outputs: [{ source }],
  ...overrides,
});

test('the name of a creation: the local time, the model, a suffix; names sort as the creations were made', () => {
  const at = new Date(2026, 10, 17, 14, 32, 5);
  assert.equal(creationName('Krea 2', { at, suffix: 'a3f9' }), '2026-11-17_14-32-05_krea-2_a3f9');
  assert.equal(creationName('LTX 2.5', { at: new Date(2026, 10, 17, 14, 40, 11), suffix: '07c2' }), '2026-11-17_14-40-11_ltx-2-5_07c2');
  assert.equal(creationName('MOSS-SFX', { at: new Date(2026, 10, 17, 15, 2, 48), suffix: '9be1' }), '2026-11-17_15-02-48_moss-sfx_9be1');
  // Every number keeps its zeros: a January morning before a December night.
  assert.equal(creationName('x', { at: new Date(2027, 0, 3, 4, 5, 6), suffix: '0000' }), '2027-01-03_04-05-06_x_0000');
  // Drawn when none is given: four hexadecimal digits, and always a name a job may carry.
  for (let count = 0; count < 50; count++) {
    const drawn = creationName('Vidéo — LTX 2.5 (brouillon)');
    assert.match(drawn, /^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d_video-ltx-2-5-brouillon_[0-9a-f]{4}$/);
    assert.ok(outputName(drawn));
  }

  // Made at increasing times, whatever their models and suffixes, they sort increasingly: as plain
  // text, and read as numbers (what a file explorer does).
  const times = [
    [2026, 0, 9, 9, 9, 9],
    [2026, 0, 9, 9, 9, 10],
    [2026, 0, 9, 9, 10, 0],
    [2026, 0, 9, 10, 0, 0],
    [2026, 0, 9, 23, 59, 59],
    [2026, 0, 10, 0, 0, 0],
    [2026, 1, 1, 0, 0, 0],
    [2026, 8, 30, 12, 0, 0],
    [2026, 9, 1, 1, 0, 0],
    [2026, 11, 31, 23, 59, 59],
    [2027, 0, 1, 0, 0, 0],
  ];
  const models = ['Zèbre', 'alpha', 'Krea 2', '9 lives', 'LTX 2.5'],
    names = times.map((time, index) =>
      creationName(models[index % models.length], { at: new Date(...time), suffix: ['ffff', '0000', 'a3f9'][index % 3] }),
    );
  const shuffled = [...names].sort(() => Math.random() - 0.5);
  assert.deepEqual([...shuffled].sort(), names);
  assert.deepEqual([...shuffled].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })), names);
  assert.deepEqual([...shuffled].sort((a, b) => a.localeCompare(b, 'fr', { numeric: true, sensitivity: 'base' })), names);
});

test('a model in a name: lower case, no accent, hyphens for the rest, thirty-two characters, never empty', () => {
  for (const [name, slug] of [
    ['Krea 2', 'krea-2'],
    ['LTX 2.5', 'ltx-2-5'],
    ['MOSS-SFX', 'moss-sfx'],
    ['Éléphant d’Été', 'elephant-d-ete'],
    ['Cœur & Æther · Straße', 'coeur-aether-strasse'],
    ['  --Wan / SCAIL-2 (v2)__final  ', 'wan-scail-2-v2-final'],
    ['İstanbul', 'istanbul'],
    ['../../etc/passwd', 'etc-passwd'],
    ['C:\\Windows\\nul', 'c-windows-nul'],
    ['a\0b\r\nc\td', 'a-b-c-d'],
    ['日本語', 'moodix'],
    ['', 'moodix'],
    ['   ', 'moodix'],
    ['---', 'moodix'],
    [undefined, 'moodix'],
    [null, 'moodix'],
  ])
    assert.equal(modelSlug(name), slug, JSON.stringify(name));
  // Cut at thirty-two characters, never on a hyphen.
  assert.equal(modelSlug('a'.repeat(40)), 'a'.repeat(32));
  assert.equal(modelSlug('a'.repeat(31) + ' b'), 'a'.repeat(31));
  // Whatever the model is called, the name has neither a separator nor anything a system refuses.
  for (const odd of ['../x', 'a/b', 'a\\b', 'C:', 'con', 'x.', 'x ', 'é'.repeat(200), '😀', '%2e%2e', 'a:b*c?d"e<f>g|h']) {
    const name = creationName(odd);
    assert.ok(outputName(name), name);
    assert.doesNotMatch(name, /[\\/:*?"<>|.\s%]/);
    assert.ok(name.length <= 96);
  }
});

test('several outputs of one creation stay together and in their order', () => {
  const name = '2026-11-17_14-32-05_krea-2_a3f9';
  assert.equal(outputPart(name), name);
  assert.equal(outputPart(name, 0, 1), name);
  assert.deepEqual([0, 1, 2].map(index => outputPart(name, index, 3)), [name + '_1', name + '_2', name + '_3']);
  // Twelve of them: 01 … 12, so that the tenth does not come before the second.
  const twelve = Array.from({ length: 12 }, (_, index) => outputPart(name, index, 12) + '.png');
  assert.equal(twelve[0], name + '_01.png');
  assert.deepEqual([...twelve].reverse().sort(), twelve);
  assert.deepEqual([...twelve].reverse().sort((a, b) => a.localeCompare(b, 'en', { numeric: true })), twelve);
  assert.ok(twelve.every(part => outputName(part.slice(0, -4))));
  // Between the creation before and the one after.
  const around = ['2026-11-17_14-32-04_krea-2_ffff.png', ...twelve, '2026-11-17_14-32-06_krea-2_0000.png'];
  assert.deepEqual([...around].reverse().sort(), around);
});

test('a name that is taken is never used again: another suffix', async t => {
  const root = await folder(t),
    name = '2026-11-17_14-32-05_krea-2_a3f9';
  assert.equal(anotherName(name, '0b0b'), '2026-11-17_14-32-05_krea-2_0b0b');
  assert.equal(anotherName('plain', '0b0b'), 'plain_0b0b');
  const paths = free => [join(root, free + '.png'), join(root, 'manifests', free + '.json')];
  assert.equal(await freeName(name, paths), name, 'free: itself');
  await writeFile(join(root, name + '.png'), png);
  const other = await freeName(name, paths);
  assert.match(other, /^2026-11-17_14-32-05_krea-2_[0-9a-f]{4}$/);
  assert.notEqual(other, name);
  // Its manifest alone being there is enough.
  await mkdir(join(root, 'manifests'));
  await writeFile(join(root, 'manifests', other + '.json'), '{}');
  const third = await freeName(other, paths);
  assert.ok(![name, other].includes(third));
  assert.deepEqual(await readFile(join(root, name + '.png')), png, 'the first one is as it was');
  // Nothing free under any suffix: said, rather than written over a creation.
  await assert.rejects(
    freeName(name, () => [join(root, name + '.png')]),
    /Aucun nom libre/,
  );
});

test('what a job may ask as a name, and where a creation may be', () => {
  assert.deepEqual(OUTPUT_FOLDERS, { image: 'image', video: 'video', audio: 'son' });
  for (const value of ['', 'image', 'video', 'son']) assert.equal(outputFolder(value), true, value);
  for (const value of [...FOREIGN, undefined, null, 0, ['image'], 'audio', 'output']) assert.equal(outputFolder(value), false, String(value));
  for (const value of ['2026-11-17_14-32-05_krea-2_a3f9', 'a', 'a-b_c', '0'.repeat(96)]) assert.equal(outputName(value), true, value);
  for (const value of ['', '.', '..', 'a.png', 'a/b', 'a\\b', 'C:a', 'A', 'a b', '_a', 'a_', 'a__b', '-a', 'é', '0'.repeat(97), 5, null, undefined])
    assert.equal(outputName(value), false, String(value));
});

test('the file of a creation is found in both forms; any other folder is refused', async t => {
  const root = await folder(t),
    output = await outputs(root);
  for (const source of [OLD, NEW]) {
    const found = await generatedFile(output, source);
    assert.equal(found.mime, 'image/png');
    assert.ok(found.path.endsWith([...(source.subfolder ? [source.subfolder] : []), source.filename].join(sep)), found.path);
    const media = await generatedMedia(output, source);
    try {
      assert.deepEqual(await media.handle.readFile(), png);
    } finally {
      await media.handle.close();
    }
  }
  // A file that is there, under a folder a record must not name: never read.
  await mkdir(join(output, 'autre'));
  await writeFile(join(output, 'autre', NEW.filename), png);
  await mkdir(join(output, 'image', '2026'));
  await writeFile(join(output, 'image', '2026', NEW.filename), png);
  for (const subfolder of [...FOREIGN, root, join(root, 'output', 'image'), 5, null, undefined])
    for (const filename of [NEW.filename, 'secret.png'])
      await assert.rejects(generatedFile(output, { filename, subfolder, type: 'output' }), /Sortie générée invalide/, String(subfolder));
  // The name itself never leaves its folder either.
  for (const filename of ['../secret.png', '..\\secret.png', 'image/' + NEW.filename, join(root, 'secret.png'), '..'])
    for (const subfolder of ['', 'image'])
      await assert.rejects(generatedFile(output, { filename, subfolder, type: 'output' }), /Sortie générée invalide/, filename);
  // (0.6.157) A file gone from the disk: said in the user's words (it was « Erreur locale inattendue »).
  await assert.rejects(generatedFile(output, { filename: 'partie.png', subfolder: 'image', type: 'output' }), {
    status: 404,
    message: 'Le fichier de cette prise n’est plus sur le disque.',
  });
});

test('the gallery keeps, lists, renumbers and forgets a take of either form; its file is never touched', async t => {
  const root = await folder(t),
    output = await outputs(root),
    historyDir = join(root, 'history'),
    conversationId = randomUUID();
  const gallery = new Gallery({ historyDir });
  const old = record(OLD, { conversationId, createdAt: '2026-11-10T10:00:00.000Z' }),
    made = record(NEW, { conversationId });
  for (const run of [old, made]) assert.deepEqual((await gallery.put(run, { persist: true })).outputs[0].source, run.outputs[0].source);
  // Read back from the disk by another start of the application.
  const again = new Gallery({ historyDir });
  assert.deepEqual((await again.get(conversationId, old.id)).outputs[0].source, OLD);
  assert.deepEqual((await again.get(conversationId, made.id)).outputs[0].source, NEW);
  const listed = await again.list(conversationId);
  assert.equal(listed.skipped, 0);
  assert.deepEqual(
    listed.runs.map(run => run.outputs[0].source),
    [NEW, OLD],
  );
  // A conversation that changes project: its takes are numbered again, their files stay where they are.
  await again.setTakes(conversationId, old.id, [4]);
  await again.setTakes(conversationId, made.id, [5]);
  assert.deepEqual((await new Gallery({ historyDir }).get(conversationId, old.id)).outputs[0], { source: OLD, take: 4 });
  assert.deepEqual((await new Gallery({ historyDir }).get(conversationId, made.id)).outputs[0], { source: NEW, take: 5 });
  // A take removed leaves the Studio; its file stays in the folder of the outputs (as before), and
  // nothing else moves.
  await again.remove(conversationId, made.id);
  await assert.rejects(again.get(conversationId, made.id), { status: 404 });
  assert.deepEqual((await again.list(conversationId)).runs.map(run => run.id), [old.id]);
  await again.remove(conversationId, old.id);
  assert.deepEqual((await readdir(output)).sort(), [OLD.filename, 'image']);
  assert.deepEqual(await readdir(join(output, 'image')), [NEW.filename]);
  assert.deepEqual(await readFile(join(output, 'image', NEW.filename)), png);
});

test('a record of the application that names another folder is refused, new or read from the disk', async t => {
  const root = await folder(t),
    historyDir = join(root, 'history'),
    gallery = new Gallery({ historyDir }),
    conversationId = randomUUID();
  for (const subfolder of [...FOREIGN, root, 5, null, undefined]) {
    const run = record({ ...NEW, subfolder }, { conversationId });
    for (const persist of [true, false]) await assert.rejects(gallery.put(run, { persist }), /invalide/, String(subfolder));
  }
  assert.deepEqual(await readdir(root), [], 'nothing was written');
  // Written by hand in the history (or by something else): never listed, never read.
  const good = record(NEW, { conversationId });
  await gallery.put(good, { persist: true });
  for (const subfolder of ['..', 'a/b', 'autre', root.replaceAll('\\', '/')]) {
    const forged = record({ ...NEW, subfolder }, { conversationId }),
      directory = join(historyDir, conversationId, 'generated', forged.id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ version: 1, ...forged }));
    await assert.rejects(new Gallery({ historyDir }).get(conversationId, forged.id), /invalide/, subfolder);
  }
  const listed = await new Gallery({ historyDir }).list(conversationId);
  assert.deepEqual([listed.runs.map(run => run.id), listed.skipped], [[good.id], 4]);
  // A record of an earlier ComfyUI names a folder of that ComfyUI: it is still read (its file never is).
  const legacy = record({ filename: 'boat.png', subfolder: 'boats/2026', type: 'output' }, { conversationId });
  delete legacy.provider;
  legacy.comfyUrl = 'http://127.0.0.1:7821';
  await gallery.put(legacy, { persist: true });
  assert.equal((await new Gallery({ historyDir }).get(conversationId, legacy.id)).outputs[0].source.subfolder, 'boats/2026');
});

test('the sheet of a creation is written in its file in both forms, and in no file a record should not name', async t => {
  const root = await folder(t),
    output = await outputs(root);
  await mkdir(join(output, 'autre'));
  await writeFile(join(output, 'autre', NEW.filename), png);
  const made = record(OLD, {
    outputs: [
      { source: OLD, take: 3 },
      { source: NEW, take: 4 },
      { source: { ...NEW, subfolder: 'autre' }, take: 5 },
      { source: { filename: 'secret.png', subfolder: '..', type: 'output' }, take: 6 },
    ],
  });
  const errors = [],
    said = console.error;
  console.error = (...words) => errors.push(words.join(' '));
  try {
    assert.deepEqual(await stampRecord(output, made, { version: '0.6.63' }), [OLD.filename, NEW.filename]);
  } finally {
    console.error = said;
  }
  assert.equal(errors.length, 2, 'the two refused are said in the terminal');
  const [old, named] = [await readFileInfo(join(output, OLD.filename)), await readFileInfo(join(output, 'image', NEW.filename))];
  assert.deepEqual([old.id, old.output, old.take, named.id, named.output, named.take], [made.id, 0, 3, made.id, 1, 4]);
  // The others are as they were, byte for byte, and no temporary file is left anywhere.
  assert.deepEqual(await readFile(join(output, 'autre', NEW.filename)), png);
  assert.deepEqual(await readFile(join(root, 'secret.png')), png);
  assert.deepEqual((await readdir(output)).sort(), [OLD.filename, 'autre', 'image']);
  assert.deepEqual(await readdir(join(output, 'image')), [NEW.filename]);
});

test('the manifests left beside the old creations still move; the three folders and their files are left alone', async t => {
  const root = await folder(t),
    output = await outputs(root),
    manifests = join(root, 'manifests');
  const stem = OLD.filename.slice(0, -4),
    manifest = JSON.stringify({ jobId: 'x', outputs: [], metadata: {} });
  await writeFile(join(output, stem + '.json'), manifest);
  for (const name of ['video', 'son']) await mkdir(join(output, name));
  await writeFile(join(output, 'video', 'clip.mp4'), 'mp4');
  // A file of the user's in a folder, even one that looks like a manifest: it is not the application's to move.
  await writeFile(join(output, 'image', NEW.filename.replace('.png', '.json')), manifest);
  assert.equal(await moveManifests(output, manifests), 1);
  assert.deepEqual(await readdir(manifests), [stem + '.json']);
  assert.deepEqual((await readdir(output)).sort(), [OLD.filename, 'image', 'son', 'video']);
  assert.deepEqual((await readdir(join(output, 'image'))).sort(), [NEW.filename.replace('.png', '.json'), NEW.filename]);
  assert.deepEqual(await readdir(join(output, 'video')), ['clip.mp4']);
  assert.deepEqual(await readdir(join(output, 'son')), []);
});

test('the application lists, serves, thumbnails and removes a take of either form; a forged folder is never served', async t => {
  const data = await folder(t, 'moodix-output-app-'),
    output = await outputs(data),
    historyDir = join(data, 'history'),
    conversationId = randomUUID();
  const old = record(OLD, { conversationId, createdAt: '2026-11-10T10:00:00.000Z' }),
    made = record(NEW, { conversationId }),
    // A manifest written by hand: a file that exists, outside the folder of the outputs.
    forged = record({ filename: 'secret.png', subfolder: '..', type: 'output' }, { conversationId });
  const seeded = new Gallery({ historyDir });
  for (const run of [old, made]) await seeded.put(run, { persist: true });
  await mkdir(join(historyDir, conversationId, 'generated', forged.id));
  await writeFile(join(historyDir, conversationId, 'generated', forged.id, 'manifest.json'), JSON.stringify({ version: 1, ...forged }));

  const app = await createApplication({ port: 0, dataDir: data });
  t.after(() => app.close());
  const { token } = await (await fetch(app.url + '/api/bootstrap?brief=1')).json();
  const auth = { Authorization: 'Bearer ' + token };
  const list = async () => (await fetch(app.url + '/api/gallery/' + conversationId + '?images=0', { headers: auth })).json();

  // Both are listed (the forged one is not), each with the address of its original.
  const listed = await list();
  assert.deepEqual([listed.runs.map(run => run.id), listed.skipped], [[made.id, old.id], 1]);
  for (const run of listed.runs) {
    const [view] = run.outputs;
    assert.deepEqual(view.source, run.id === old.id ? OLD : NEW);
    assert.match(view.originalUrl, /^\/media\/generated\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/0\?key=[0-9a-f]{64}$/);
    // Served by its signed address (what the page shows and downloads), and to the page itself.
    const signed = await fetch(app.url + view.originalUrl);
    assert.equal(signed.status, 200);
    assert.equal(signed.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await signed.arrayBuffer()), png);
    const direct = await fetch(`${app.url}/api/gallery/${conversationId}/${run.id}/0`, { headers: auth });
    assert.equal(direct.status, 200);
    assert.deepEqual(Buffer.from(await direct.arrayBuffer()), png);
    // A part of it, as a player asks.
    const part = await fetch(app.url + view.originalUrl, { headers: { Range: 'bytes=0-7' } });
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), png.subarray(0, 8));
    // Its thumbnail, sent once by the page, then served.
    const sent = await fetch(app.url + '/api/gallery/thumbnail', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'image/jpeg', 'X-Conversation-Id': conversationId, 'X-Run-Id': run.id, 'X-Output-Index': '0' },
      body: jpeg,
    });
    assert.equal(sent.status, 201, await sent.clone().text());
    const { thumbUrl } = await sent.json();
    assert.deepEqual(Buffer.from(await (await fetch(app.url + thumbUrl)).arrayBuffer()), jpeg);
  }
  assert.ok((await list()).runs.every(run => run.outputs[0].thumbUrl), 'the creations give their thumbnails');
  // Each one kept under its conversation, its run and its output: where its file is changes nothing.
  assert.deepEqual((await readdir(join(data, 'thumbnails'))).sort(), [made.id, old.id].map(id => `${conversationId}.${id}.0.jpg`).sort());

  // The forged record gives nothing: neither read, nor served, nor thumbnailed.
  for (const path of [`/api/gallery/${conversationId}/${forged.id}`, `/api/gallery/${conversationId}/${forged.id}/0`]) {
    const refused = await fetch(app.url + path, { headers: auth });
    assert.equal(refused.status, 400, path);
    assert.doesNotMatch(await refused.text(), /PNG/);
  }
  const refused = await fetch(app.url + '/api/gallery/thumbnail', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'image/jpeg', 'X-Conversation-Id': conversationId, 'X-Run-Id': forged.id, 'X-Output-Index': '0' },
    body: jpeg,
  });
  assert.equal(refused.status, 400);

  // A take removed from the Studio, in a folder or not: its record and its thumbnail go, its file
  // stays where it is (as before the folders), and nothing else is touched.
  const remove = id =>
    fetch(app.url + '/api/studio/delete', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, id }),
    });
  assert.equal((await remove(made.id)).status, 200);
  assert.deepEqual((await list()).runs.map(run => run.id), [old.id]);
  assert.deepEqual(await readdir(join(data, 'thumbnails')), [`${conversationId}.${old.id}.0.jpg`]);
  assert.equal((await fetch(`${app.url}/api/gallery/${conversationId}/${made.id}/0`, { headers: auth })).status, 404);
  assert.equal((await remove(old.id)).status, 200);
  assert.deepEqual((await list()).runs, []);
  assert.deepEqual(await readdir(join(data, 'thumbnails')), []);
  assert.deepEqual((await readdir(output)).sort(), [OLD.filename, 'image']);
  assert.deepEqual(await readdir(join(output, 'image')), [NEW.filename]);
  for (const path of [join(output, OLD.filename), join(output, 'image', NEW.filename), join(data, 'secret.png')])
    assert.deepEqual(await readFile(path), png, path);
});

test('a creation stopped with its engine leaves nothing half-written: only the files of its own name go', async t => {
  const { leftTemporaries } = await import('../lib/generation-service.mjs');
  const root = await mkdtemp(join(tmpdir(), 'moodix-left-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const name = '2026-11-17_14-32-05_rife_a3f9',
    other = '2026-11-17_14-40-11_ltx-2-5_07c2';
  await mkdir(join(root, 'video'));
  const kept = [`${other}.tmp.mp4`, 'mes vacances.tmp.mp4', `${name}.mp4`, join('video', `${name}.mp4`)],
    gone = [`${name}.tmp.mp4`, `${name}.tmp.mux.mp4`, `${name}.mux.mp4`, `${name}.png.tmp`, `${name}.wav.tmp`, `${name}.tmp.wav`];
  for (const file of [...kept, ...gone]) await writeFile(join(root, file), 'x');
  await leftTemporaries(root, name);
  const left = (await readdir(root, { recursive: true })).filter(item => item.includes('.')).map(item => item.replaceAll(sep, '/'));
  assert.deepEqual(left.sort(), kept.map(item => item.replaceAll(sep, '/')).sort());
  // A name that is not one of a creation removes nothing (no folder, no dot, nothing above).
  for (const bad of ['../' + other, other + '.tmp', '', undefined, 'video/' + other]) await leftTemporaries(root, bad);
  assert.equal((await readdir(root)).includes(`${other}.tmp.mp4`), true);
});
