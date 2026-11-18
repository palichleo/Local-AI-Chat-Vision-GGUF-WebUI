import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../server.mjs';
import { History } from '../lib/history.mjs';
import { Gallery } from '../lib/gallery.mjs';
import { Takes } from '../lib/takes.mjs';
import { Thumbnails } from '../lib/thumbnails.mjs';
import { StudioPresets } from '../lib/studio-presets.mjs';
import { ProgressHistory } from '../lib/generation-progress.mjs';

/**
 * Windows refusing for an instant to put the new copy of a file in its place (an antivirus reading
 * what was just written, the indexer): the first two renames onto each file of `paths` refused
 * (EPERM, then EBUSY), every other rename let through. Each module imports fs.rename itself: it is
 * replaced for the time of `work` (module.syncBuiltinESMExports). Resolves with the number of
 * refusals of each file: 2 for a file written once its refusals were tried again.
 */
async function held(paths, work) {
  const rename = fs.rename,
    refused = new Map(paths.map(path => [resolve(path), 0]));
  fs.rename = async (from, to) => {
    const count = refused.get(resolve(to));
    if (count === undefined || count >= 2) return rename(from, to);
    refused.set(resolve(to), count + 1);
    const code = count ? 'EBUSY' : 'EPERM';
    throw Object.assign(new Error(`${code}: refused for an instant, rename '${from}' -> '${to}'`), { code });
  };
  syncBuiltinESMExports();
  try {
    await work();
  } finally {
    fs.rename = rename;
    syncBuiltinESMExports();
  }
  return Object.fromEntries(refused);
}
const twice = paths => Object.fromEntries(paths.map(path => [resolve(path), 2]));
const leftBeside = async paths => {
  const left = [];
  for (const folder of new Set(paths.map(path => dirname(path))))
    for (const name of await readdir(folder)) if (name.endsWith('.tmp')) left.push(join(folder, name));
  return left;
};

test('conversation, prise, compteurs des prises, vignette, réglages du Studio, temps des générations : réessayés quand Windows refuse un instant', async t => {
  const root = await mkdtemp(join(tmpdir(), 'atelier-data-writes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const historyDir = join(root, 'history'),
    conversation = randomUUID(),
    run = {
      id: randomUUID(),
      conversationId: conversation,
      workflowId: 'basic',
      workflowName: 'Basic image',
      prompt: 'Un bateau rouge',
      parameters: { seed: 42, width: 512 },
      comfyUrl: 'http://127.0.0.1:7821',
      createdAt: '2026-11-18T10:00:00.000Z',
      outputs: [{ source: { filename: 'bateau.png', subfolder: '', type: 'output' } }],
    },
    key = Thumbnails.key(conversation, run.id),
    jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]),
    history = new History(historyDir),
    gallery = new Gallery({ historyDir }),
    takes = new Takes(join(root, 'takes.json')),
    thumbnails = await new Thumbnails(join(root, 'thumbnails')).load(),
    presets = new StudioPresets(join(root, 'studio-presets.json')),
    timings = new ProgressHistory(join(root, 'generation-timings.json')),
    files = {
      conversation: join(historyDir, conversation, 'conversation.json'),
      take: join(historyDir, conversation, 'generated', run.id, 'manifest.json'),
      counters: join(root, 'takes.json'),
      thumbnail: join(root, 'thumbnails', key + '.jpg'),
      presets: join(root, 'studio-presets.json'),
      timings: join(root, 'generation-timings.json'),
    };
  const refused = await held(Object.values(files), async () => {
    await history.save({ id: conversation, messages: [{ role: 'user', content: 'Un bateau rouge' }] });
    await gallery.put(run, { persist: true });
    assert.deepEqual(await takes.next('inbox', 2), [1, 2]);
    assert.equal(await thumbnails.write(key, jpeg), true);
    await presets.save('ltx-video', { seed: '42' });
    await timings.save('image', [
      { mark: 'start', at: 0 },
      { mark: 'done', at: 12.5 },
    ]);
  });
  assert.deepEqual(refused, twice(Object.values(files)));
  // Each is there whole, and nothing is left beside it.
  assert.deepEqual((await history.read(conversation)).messages.map(message => message.content), ['Un bateau rouge']);
  assert.equal((await new Gallery({ historyDir }).get(conversation, run.id)).prompt, 'Un bateau rouge');
  assert.deepEqual(JSON.parse(await readFile(files.counters, 'utf8')), { version: 1, projects: { inbox: 2 } });
  assert.deepEqual(await readFile(files.thumbnail), jpeg);
  assert.equal((await presets.all())['ltx-video'].seed, '42');
  assert.deepEqual(Object.keys(JSON.parse(await readFile(files.timings, 'utf8')).timelines), ['image']);
  assert.deepEqual(await leftBeside(Object.values(files)), []);
});

test('préférences, réglages des Paramètres et configuration du modèle : réessayés quand Windows refuse un instant', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'atelier-data-writes-api-'));
  let app;
  try {
    app = await createApplication({ port: 0, dataDir });
    const bootstrap = await (await fetch(app.url + '/api/bootstrap')).json();
    const call = async (route, body) => {
      const answer = await fetch(app.url + '/api/' + route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bootstrap.token}` },
        body: JSON.stringify(body),
      });
      assert.equal(answer.status, 200, `${route} : ${await answer.text()}`);
    };
    const preferences = join(dataDir, 'preferences.json'),
      config = join(dataDir, 'config.json'),
      generation = join(dataDir, 'generation.json');
    // « Enregistrer l'historique » turned off; « Enregistrer » of the Paramètres: the model's
    // configuration and the generation's (before 0.6.84: « Erreur locale inattendue »).
    let refused = await held([preferences, config, generation], async () => {
      await call('preferences', { saveHistory: false });
      await call('settings', {
        config: { ...bootstrap.config, contextSize: bootstrap.config.contextSize === 12288 ? 10240 : 12288 },
        generation: { ...bootstrap.generation, reviewImages: true },
      });
    });
    assert.deepEqual(refused, twice([preferences, config, generation]));
    // The configuration of the model alone.
    refused = await held([config], () => call('config', { ...bootstrap.config, contextSize: 16384 }));
    assert.deepEqual(refused, twice([config]));
    assert.equal(JSON.parse(await readFile(preferences, 'utf8')).saveHistory, false);
    assert.equal(JSON.parse(await readFile(config, 'utf8')).contextSize, 16384);
    assert.equal(JSON.parse(await readFile(generation, 'utf8')).reviewImages, true);
    assert.deepEqual(await leftBeside([preferences]), []);
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
