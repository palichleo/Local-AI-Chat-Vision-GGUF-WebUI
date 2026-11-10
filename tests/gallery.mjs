import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Gallery } from '../lib/gallery.mjs';

const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rLkAAAAASUVORK5CYII=';
const jpeg = 'data:image/jpeg;base64,/9j/2Q==';
function record(overrides = {}) {
  return {
    id: randomUUID(),
    conversationId: randomUUID(),
    workflowId: 'basic',
    workflowName: 'Basic image',
    prompt: 'A red boat',
    parameters: { seed: 42, width: 512 },
    comfyUrl: 'http://127.0.0.1:7821',
    createdAt: '2026-11-08T01:00:00.000Z',
    outputs: [{ source: { filename: 'original.png', subfolder: 'boats/2026', type: 'output' } }],
    ...overrides,
  };
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-gallery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, historyDir: join(directory, 'history') };
}

test('persistent metadata restores from disk; analysis copies stay in session memory only', async t => {
  const { directory, historyDir } = await fixture(t);
  const originals = join(directory, 'ComfyUI', 'output', 'boats', '2026');
  await mkdir(originals, { recursive: true });
  const originalPath = join(originals, 'original.png');
  const original = Buffer.from('an original that the gallery must never read, rewrite or delete');
  await writeFile(originalPath, original);
  const run = record();
  const gallery = new Gallery({ historyDir });
  await gallery.put(run, { persist: true });
  const runDir = join(historyDir, run.conversationId, 'generated', run.id);
  assert.deepEqual(await readdir(runDir), ['manifest.json']);
  assert.deepEqual(await new Gallery({ historyDir }).get(run.conversationId, run.id), run);
  const reviewed = {
    ...run,
    analysis: { status: 'accepted', text: 'The boat is red.' },
    outputs: [{ ...run.outputs[0], analysisDataUrl: png }],
  };
  await gallery.put(reviewed, { persist: true });
  const manifest = await readFile(join(runDir, 'manifest.json'), 'utf8');
  assert.ok(!manifest.includes('base64,'));
  assert.deepEqual(await readdir(runDir), ['manifest.json'], 'no compressed copy on disk');
  assert.deepEqual(await gallery.get(run.conversationId, run.id), reviewed, 'the copy serves this session');
  const restarted = new Gallery({ historyDir });
  const { analysisDataUrl, ...withoutCopy } = reviewed.outputs[0];
  assert.deepEqual(await restarted.get(run.conversationId, run.id), { ...reviewed, outputs: [withoutCopy] });
  assert.deepEqual(await restarted.list(run.conversationId), { runs: [{ ...reviewed, outputs: [withoutCopy] }], skipped: 0 });
  await rm(historyDir, { recursive: true });
  gallery.clearMemory();
  assert.deepEqual(await readFile(originalPath), original);
  assert.deepEqual(await gallery.list(run.conversationId), { runs: [], skipped: 0 });
});

test('nonpersistent runs stay in memory, are cloned and clearMemory never removes files', async t => {
  const { historyDir } = await fixture(t);
  const gallery = new Gallery({ historyDir });
  const run = record({
    outputs: [{ source: { filename: 'x.jpg', subfolder: '', type: 'output' }, analysisDataUrl: jpeg }],
  });
  const expected = structuredClone(run);
  await gallery.put(run, { persist: false });
  run.parameters.seed = 0;
  const loaded = await gallery.get(run.conversationId, run.id);
  loaded.parameters.seed = 10;
  assert.deepEqual(await gallery.get(run.conversationId, run.id), expected);
  await assert.rejects(readdir(historyDir), { code: 'ENOENT' });
  assert.deepEqual(await new Gallery({ historyDir }).list(run.conversationId), { runs: [], skipped: 0 });
  gallery.clearMemory();
  await assert.rejects(gallery.get(run.conversationId, run.id), { status: 404 });
  await gallery.put(expected, { persist: true });
  assert.deepEqual(await gallery.get(run.conversationId, run.id), expected);
  gallery.clearMemory();
  const { analysisDataUrl, ...output } = expected.outputs[0];
  assert.deepEqual(await gallery.get(run.conversationId, run.id), { ...expected, outputs: [output] });
});

test('queued updates retain session analysis copies and newest runs list first', async t => {
  const { historyDir } = await fixture(t);
  const gallery = new Gallery({ historyDir });
  const run = record({
    outputs: [{ source: { filename: 'x.png', subfolder: '', type: 'output' }, analysisDataUrl: png }],
  });
  const metadata = { ...run, analysis: 'The final review', outputs: [{ source: run.outputs[0].source }] };
  const newer = record({ conversationId: run.conversationId, createdAt: '2026-11-08T02:00:00.000Z' });
  await Promise.all([
    gallery.put(run, { persist: true }),
    gallery.put(metadata, { persist: true }),
    gallery.put(newer, { persist: false }),
  ]);
  const list = await gallery.list(run.conversationId);
  assert.deepEqual(
    list.runs.map(item => item.id),
    [newer.id, run.id],
  );
  const restored = await gallery.get(run.conversationId, run.id);
  assert.equal(restored.analysis, 'The final review');
  assert.equal(restored.outputs[0].analysisDataUrl, png);
  assert.deepEqual(await readdir(join(historyDir, run.conversationId, 'generated', run.id)), ['manifest.json']);
  gallery.forgetConversation(run.conversationId);
  assert.equal((await gallery.get(run.conversationId, run.id)).outputs[0].analysisDataUrl, undefined);
});

test('invalid IDs, output descriptors, remote URLs and malformed copies never create history', async t => {
  const { historyDir } = await fixture(t);
  const gallery = new Gallery({ historyDir });
  const source = record().outputs[0].source;
  const invalid = [
    { id: '../outside' },
    { conversationId: '../outside' },
    { workflowId: '../unsafe' },
    { comfyUrl: 42 },
    { outputs: [{ source: { ...source, filename: '../secret.png' } }] },
    { outputs: [{ source: { ...source, filename: 'C:\\secret.png' } }] },
    { outputs: [{ source: { ...source, filename: '%2e%2e.png' } }] },
    { outputs: [{ source: { ...source, subfolder: 'valid/../secret' } }] },
    { outputs: [{ source: { ...source, subfolder: 'valid\\secret' } }] },
    { outputs: [{ source: { ...source, type: 'input' } }] },
    { outputs: [{ source, analysisDataUrl: 'data:image/png;base64,SGVsbG8=' }] },
    { outputs: [{ source, analysisDataUrl: png.replace('image/png', 'image/jpeg') }] },
    { outputs: [{ source, analysisDataUrl: 'data:image/webp;base64,UklGRg==' }] },
    {
      outputs: [
        {
          source,
          analysisDataUrl: `data:image/png;base64,${Buffer.concat([Buffer.from(png.split(',')[1], 'base64'), Buffer.alloc(5 * 1024 * 1024)]).toString('base64')}`,
        },
      ],
    },
    { parameters: { reference_image: png } },
    { analysis: { image: png } },
    { outputs: [] },
  ];
  for (const change of invalid) await assert.rejects(gallery.put(record(change), { persist: true }), { status: 400 });
  await assert.rejects(gallery.get('../outside', randomUUID()), { status: 400 });
  await assert.rejects(gallery.list('../outside'), { status: 400 });
  await assert.rejects(readdir(historyDir), { code: 'ENOENT' });
});

test('tampered manifests cannot escape a run; copies left by earlier versions are ignored', async t => {
  const { directory, historyDir } = await fixture(t);
  const gallery = new Gallery({ historyDir });
  const run = record({ outputs: [{ source: { filename: 'x.png', subfolder: '', type: 'output' } }] });
  await gallery.put(run, { persist: true });
  const runDir = join(historyDir, run.conversationId, 'generated', run.id);
  const manifestPath = join(runDir, 'manifest.json');
  const originalManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const restored = new Gallery({ historyDir });
  // An earlier version stored a compressed copy beside the manifest: it is no longer read.
  await writeFile(join(runDir, 'analysis-' + 'a'.repeat(64) + '.png'), Buffer.from('tampered'));
  await writeFile(
    manifestPath,
    JSON.stringify({ ...originalManifest, outputs: [{ ...originalManifest.outputs[0], analysisImage: '../../secret.png' }] }),
  );
  assert.deepEqual(await restored.get(run.conversationId, run.id), run);
  for (const change of [
    { ...originalManifest, id: randomUUID() },
    { ...originalManifest, outputs: [{ source: { ...run.outputs[0].source, filename: '../x.png' } }] },
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

test('symlinks in history ancestors and existing manifest files are rejected', async t => {
  const { directory, historyDir } = await fixture(t);
  const outside = join(directory, 'outside');
  await mkdir(outside);
  await symlink(outside, historyDir, 'junction');
  const run = record();
  await assert.rejects(new Gallery({ historyDir }).put(run, { persist: true }), { status: 400 });
  assert.deepEqual(await readdir(outside), []);
  await rm(historyDir);
  const gallery = new Gallery({ historyDir });
  await gallery.put(run, { persist: true });
  const manifestPath = join(historyDir, run.conversationId, 'generated', run.id, 'manifest.json');
  const outsideFile = join(outside, 'manifest.json');
  await writeFile(outsideFile, 'untouched');
  await rm(manifestPath);
  try {
    await symlink(outsideFile, manifestPath, 'file');
  } catch (error) {
    if (error.code === 'EPERM') {
      t.diagnostic('File symlink check unavailable without Windows symlink permission; junction checks ran.');
      return;
    }
    throw error;
  }
  await assert.rejects(gallery.put(run, { persist: true }), { status: 400 });
  await assert.rejects(new Gallery({ historyDir }).get(run.conversationId, run.id), { status: 400 });
  assert.equal(await readFile(outsideFile, 'utf8'), 'untouched');
});

test('hardlinked manifests cannot alias an original file', async t => {
  const { directory, historyDir } = await fixture(t);
  const gallery = new Gallery({ historyDir });
  const run = record({ outputs: [{ source: { filename: 'x.png', subfolder: '', type: 'output' } }] });
  await gallery.put(run, { persist: true });
  const manifest = join(historyDir, run.conversationId, 'generated', run.id, 'manifest.json');
  const manifestOriginal = join(directory, 'original-manifest.json');
  await writeFile(manifestOriginal, await readFile(manifest));
  await rm(manifest);
  await link(manifestOriginal, manifest);
  await assert.rejects(gallery.put(run, { persist: true }), { status: 400 });
  await assert.rejects(new Gallery({ historyDir }).get(run.conversationId, run.id), { status: 400 });
  assert.ok(await readFile(manifestOriginal, 'utf8'));
});

test('original pixel dimensions survive persistence and later metadata writes', async t => {
  const { historyDir } = await fixture(t),
    gallery = new Gallery({ historyDir }),
    run = record();
  run.outputs[0].width = 1448;
  run.outputs[0].height = 1448;
  await gallery.put(run, { persist: true });
  const restored = await new Gallery({ historyDir }).get(run.conversationId, run.id);
  assert.equal(restored.outputs[0].width, 1448);
  assert.equal(restored.outputs[0].height, 1448);
  const stale = record({ ...run, outputs: [{ source: run.outputs[0].source }], analysis: { text: 'Review' } });
  await gallery.put(stale, { persist: true });
  assert.equal((await gallery.get(run.conversationId, run.id)).outputs[0].width, 1448);
});

test('persisted gallery copies do not accumulate in process memory, but unsaved copies stay recoverable', async t => {
  const { historyDir } = await fixture(t),
    gallery = new Gallery({ historyDir });
  const run = record({
    outputs: [{ source: { filename: 'copy.png', subfolder: '', type: 'output' }, analysisDataUrl: png }],
  });
  await gallery.put(run);
  assert.equal(gallery.records.size, 1);
  await gallery.put(run, { persist: true });
  assert.equal(gallery.records.size, 0);
  assert.deepEqual(await gallery.get(run.conversationId, run.id), run);
});
test('original lookup reads metadata without session copies or retaining the last write result', async t => {
  const { historyDir } = await fixture(t),
    gallery = new Gallery({ historyDir });
  const run = record({
    outputs: [{ source: { filename: 'copy.png', subfolder: '', type: 'output' }, analysisDataUrl: png }],
  });
  await gallery.put(run, { persist: true });
  assert.equal(await gallery.pending, undefined);
  const metadata = await gallery.get(run.conversationId, run.id, { includeImages: false });
  assert.equal(metadata.outputs[0].analysisDataUrl, undefined);
  assert.equal(metadata.outputs[0].source.filename, 'copy.png');
  assert.equal((await gallery.get(run.conversationId, run.id)).outputs[0].analysisDataUrl, png);
});

test('video kind persists; timestamped reduced frames stay in session memory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-video-gallery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const gallery = new Gallery({ historyDir: directory });
  const record = {
    id: 'a1111111-1111-4111-8111-111111111111',
    conversationId: 'b2222222-2222-4222-8222-222222222222',
    workflowId: 'motion',
    workflowName: 'Custom motion',
    mediaType: 'video',
    createdAt: new Date().toISOString(),
    prompt: 'Slow pan',
    parameters: { stage: 'draft', frames: 81, fps: 16 },
    comfyUrl: 'http://127.0.0.1:8188',
    outputs: [
      {
        source: { filename: 'clip.mp4', subfolder: '', type: 'output' },
        analysisDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        analysisFrames: [
          { time: 0, url: 'data:image/png;base64,iVBORw0KGgo=' },
          { time: 2, url: 'data:image/jpeg;base64,/9j/' },
        ],
      },
    ],
  };
  await gallery.put(record, { persist: true });
  assert.deepEqual((await gallery.get(record.conversationId, record.id)).outputs[0].analysisFrames, record.outputs[0].analysisFrames);
  const loaded = await new Gallery({ historyDir: directory }).get(record.conversationId, record.id);
  assert.equal(loaded.mediaType, 'video');
  assert.equal(loaded.outputs[0].analysisFrames, undefined);
  assert.deepEqual(await readdir(join(directory, record.conversationId, 'generated', record.id)), ['manifest.json']);
  const metadata = await gallery.get(record.conversationId, record.id, { includeImages: false });
  assert.equal(metadata.outputs[0].analysisFrames, undefined);
  await assert.rejects(
    gallery.put({
      ...record,
      outputs: [{ ...record.outputs[0], analysisFrames: [{ time: -1, url: 'data:image/png;base64,iVBORw0KGgo=' }] }],
    }),
    /vidéo|video|time|image/i,
  );
});
