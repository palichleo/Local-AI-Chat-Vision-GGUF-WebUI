import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ComfyGallery } from '../lib/comfy-gallery.mjs';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rLkAAAAASUVORK5CYII=';
const jpeg = 'data:image/jpeg;base64,/9j/2Q==';
function record(overrides = {}) {
  return { id: randomUUID(), conversationId: randomUUID(), workflowId: 'basic', workflowName: 'Basic image', prompt: 'A red boat', parameters: { seed: 42, width: 512 }, comfyUrl: 'http://127.0.0.1:7821', createdAt: '2026-11-08T01:00:00.000Z', outputs: [{ source: { filename: 'original.png', subfolder: 'boats/2026', type: 'output' } }], ...overrides };
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-gallery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, historyDir: join(directory, 'history') };
}

test('persistent metadata and later analysis copies restore without touching original Comfy files', async (t) => {
  const { directory, historyDir } = await fixture(t);
  const originals = join(directory, 'ComfyUI', 'output', 'boats', '2026');
  await mkdir(originals, { recursive: true });
  const originalPath = join(originals, 'original.png');
  const original = Buffer.from('an original that the gallery must never read, rewrite or delete');
  await writeFile(originalPath, original);
  const run = record();
  const gallery = new ComfyGallery({ historyDir });
  await gallery.put(run, { persist: true });
  const runDir = join(historyDir, run.conversationId, 'generated', run.id);
  assert.deepEqual(await readdir(runDir), ['manifest.json']);
  assert.deepEqual(await new ComfyGallery({ historyDir }).get(run.conversationId, run.id), run);
  const reviewed = { ...run, analysis: { status: 'accepted', text: 'The boat is red.' }, outputs: [{ ...run.outputs[0], analysisDataUrl: png }] };
  await gallery.put(reviewed, { persist: true });
  const manifest = await readFile(join(runDir, 'manifest.json'), 'utf8');
  assert.ok(!manifest.includes('base64,'));
  const files = await readdir(runDir);
  assert.equal(files.length, 2);
  const copy = files.find((name) => name !== 'manifest.json');
  assert.deepEqual(await readFile(join(runDir, copy)), Buffer.from(png.split(',')[1], 'base64'));
  gallery.clearMemory();
  const restarted = new ComfyGallery({ historyDir });
  assert.deepEqual(await restarted.get(run.conversationId, run.id), reviewed);
  assert.deepEqual(await restarted.list(run.conversationId), { runs: [reviewed], skipped: 0 });
  await rm(historyDir, { recursive: true });
  gallery.clearMemory();
  assert.deepEqual(await readFile(originalPath), original);
  assert.deepEqual(await gallery.list(run.conversationId), { runs: [], skipped: 0 });
});

test('nonpersistent runs stay in memory, are cloned and clearMemory never removes files', async (t) => {
  const { historyDir } = await fixture(t);
  const gallery = new ComfyGallery({ historyDir });
  const run = record({ outputs: [{ source: { filename: 'x.jpg', subfolder: '', type: 'output' }, analysisDataUrl: jpeg }] });
  const expected = structuredClone(run);
  await gallery.put(run, { persist: false });
  run.parameters.seed = 0;
  const loaded = await gallery.get(run.conversationId, run.id);
  loaded.parameters.seed = 10;
  assert.deepEqual(await gallery.get(run.conversationId, run.id), expected);
  await assert.rejects(readdir(historyDir), { code: 'ENOENT' });
  assert.deepEqual(await new ComfyGallery({ historyDir }).list(run.conversationId), { runs: [], skipped: 0 });
  gallery.clearMemory();
  await assert.rejects(gallery.get(run.conversationId, run.id), { status: 404 });
  await gallery.put(expected, { persist: true });
  gallery.clearMemory();
  assert.deepEqual(await gallery.get(run.conversationId, run.id), expected);
});

test('queued updates retain analysis copies and newest runs list first', async (t) => {
  const { historyDir } = await fixture(t);
  const gallery = new ComfyGallery({ historyDir });
  const run = record({ outputs: [{ source: { filename: 'x.png', subfolder: '', type: 'output' }, analysisDataUrl: png }] });
  const metadata = { ...run, analysis: 'The final review', outputs: [{ source: run.outputs[0].source }] };
  const newer = record({ conversationId: run.conversationId, createdAt: '2026-11-08T02:00:00.000Z' });
  await Promise.all([gallery.put(run, { persist: true }), gallery.put(metadata, { persist: true }), gallery.put(newer, { persist: false })]);
  const list = await gallery.list(run.conversationId);
  assert.deepEqual(list.runs.map((item) => item.id), [newer.id, run.id]);
  gallery.clearMemory();
  const restored = await gallery.get(run.conversationId, run.id);
  assert.equal(restored.analysis, 'The final review');
  assert.equal(restored.outputs[0].analysisDataUrl, png);
  assert.equal((await readdir(join(historyDir, run.conversationId, 'generated', run.id))).length, 2);
});

test('invalid IDs, output descriptors, remote URLs and malformed copies never create history', async (t) => {
  const { historyDir } = await fixture(t);
  const gallery = new ComfyGallery({ historyDir });
  const source = record().outputs[0].source;
  const invalid = [
    { id: '../outside' }, { conversationId: '../outside' }, { workflowId: '../unsafe' },
    { comfyUrl: 'https://127.0.0.1:7821' }, { comfyUrl: 'http://example.com:7821' }, { comfyUrl: 'http://localhost:7821/../../outside' },
    { outputs: [{ source: { ...source, filename: '../secret.png' } }] },
    { outputs: [{ source: { ...source, filename: 'C:\\secret.png' } }] },
    { outputs: [{ source: { ...source, filename: '%2e%2e.png' } }] },
    { outputs: [{ source: { ...source, subfolder: 'valid/../secret' } }] },
    { outputs: [{ source: { ...source, subfolder: 'valid\\secret' } }] },
    { outputs: [{ source: { ...source, type: 'input' } }] },
    { outputs: [{ source, analysisDataUrl: 'data:image/png;base64,SGVsbG8=' }] },
    { outputs: [{ source, analysisDataUrl: png.replace('image/png', 'image/jpeg') }] },
    { outputs: [{ source, analysisDataUrl: 'data:image/webp;base64,UklGRg==' }] },
    { outputs: [{ source, analysisDataUrl: `data:image/png;base64,${Buffer.concat([Buffer.from(png.split(',')[1], 'base64'), Buffer.alloc(5 * 1024 * 1024)]).toString('base64')}` }] },
    { parameters: { reference_image: png } }, { analysis: { image: png } }, { outputs: [] },
  ];
  for (const change of invalid) await assert.rejects(gallery.put(record(change), { persist: true }), { status: 400 });
  await assert.rejects(gallery.get('../outside', randomUUID()), { status: 400 });
  await assert.rejects(gallery.list('../outside'), { status: 400 });
  await assert.rejects(readdir(historyDir), { code: 'ENOENT' });
});

test('tampered manifests and copied bytes cannot escape a run or bypass integrity checks', async (t) => {
  const { directory, historyDir } = await fixture(t);
  const gallery = new ComfyGallery({ historyDir });
  const run = record({ outputs: [{ source: { filename: 'x.png', subfolder: '', type: 'output' }, analysisDataUrl: png }] });
  await gallery.put(run, { persist: true });
  const runDir = join(historyDir, run.conversationId, 'generated', run.id);
  const manifestPath = join(runDir, 'manifest.json');
  const originalManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const copy = (await readdir(runDir)).find((name) => name !== 'manifest.json');
  await writeFile(join(runDir, copy), Buffer.from('tampered'));
  const restored = new ComfyGallery({ historyDir });
  await assert.rejects(restored.get(run.conversationId, run.id), { status: 400 });
  assert.deepEqual(await restored.list(run.conversationId), { runs: [], skipped: 1 });
  await writeFile(join(runDir, copy), Buffer.from(png.split(',')[1], 'base64'));
  for (const change of [
    { ...originalManifest, id: randomUUID() },
    { ...originalManifest, outputs: [{ source: run.outputs[0].source, analysisImage: '../../secret.png' }] },
    { ...originalManifest, outputs: [{ source: run.outputs[0].source, analysisDataUrl: png }] },
  ]) {
    await writeFile(manifestPath, JSON.stringify(change));
    await assert.rejects(restored.get(run.conversationId, run.id), { status: 400 });
  }
  await writeFile(manifestPath, JSON.stringify(originalManifest));
  await rm(runDir, { recursive: true });
  const outside = join(directory, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'sentinel'), 'leave me');
  await symlink(outside, runDir, 'junction');
  await assert.rejects(restored.get(run.conversationId, run.id), { status: 400 });
  await assert.rejects(restored.put(run, { persist: true }), { status: 400 });
  assert.deepEqual(await readdir(outside), ['sentinel']);
});

test('symlinks in history ancestors and existing manifest files are rejected', async (t) => {
  const { directory, historyDir } = await fixture(t);
  const outside = join(directory, 'outside');
  await mkdir(outside);
  await symlink(outside, historyDir, 'junction');
  const run = record();
  await assert.rejects(new ComfyGallery({ historyDir }).put(run, { persist: true }), { status: 400 });
  assert.deepEqual(await readdir(outside), []);
  await rm(historyDir);
  const gallery = new ComfyGallery({ historyDir });
  await gallery.put(run, { persist: true });
  const manifestPath = join(historyDir, run.conversationId, 'generated', run.id, 'manifest.json');
  const outsideFile = join(outside, 'manifest.json');
  await writeFile(outsideFile, 'untouched');
  await rm(manifestPath);
  try { await symlink(outsideFile, manifestPath, 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.diagnostic('File symlink check unavailable without Windows symlink permission; junction checks ran.'); return; } throw error; }
  await assert.rejects(gallery.put(run, { persist: true }), { status: 400 });
  await assert.rejects(new ComfyGallery({ historyDir }).get(run.conversationId, run.id), { status: 400 });
  assert.equal(await readFile(outsideFile, 'utf8'), 'untouched');
});

test('hardlinked manifests and analysis copies cannot alias an original file', async (t) => {
  const { directory, historyDir } = await fixture(t);
  const gallery = new ComfyGallery({ historyDir });
  const run = record({ outputs: [{ source: { filename: 'x.png', subfolder: '', type: 'output' }, analysisDataUrl: png }] });
  await gallery.put(run, { persist: true });
  const runDir = join(historyDir, run.conversationId, 'generated', run.id);
  const manifest = join(runDir, 'manifest.json');
  const original = join(directory, 'original.png');
  await writeFile(original, Buffer.from(png.split(',')[1], 'base64'));
  const copy = (await readdir(runDir)).find((name) => name !== 'manifest.json');
  await rm(join(runDir, copy));
  await link(original, join(runDir, copy));
  await assert.rejects(new ComfyGallery({ historyDir }).get(run.conversationId, run.id), { status: 400 });
  await assert.rejects(gallery.put(run, { persist: true }), { status: 400 });
  await rm(join(runDir, copy));
  const manifestOriginal = join(directory, 'original-manifest.json');
  await writeFile(manifestOriginal, await readFile(manifest));
  await rm(manifest);
  await link(manifestOriginal, manifest);
  await assert.rejects(gallery.put(run, { persist: true }), { status: 400 });
  assert.equal(await readFile(original, 'base64'), png.split(',')[1]);
  assert.ok(await readFile(manifestOriginal, 'utf8'));
});
