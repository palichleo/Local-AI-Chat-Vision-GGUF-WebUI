import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Thumbnails } from '../lib/thumbnails.mjs';
import { createApplication } from '../server.mjs';

const conversation = 'a1111111-1111-4111-8111-111111111111',
  other = 'b2222222-2222-4222-8222-222222222222',
  run = 'c3333333-3333-4333-8333-333333333333';
// The first bytes of a JPEG are enough for what the server checks.
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);

test('thumbnails are kept once per output, read back and forgotten with their conversation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-thumbs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const thumbs = await new Thumbnails(join(directory, 'thumbnails')).load();
  const key = Thumbnails.key(conversation, run, 0);
  assert.equal(thumbs.has(key), false);
  assert.equal(await thumbs.write(key, jpeg), true);
  // A creation does not change: its thumbnail is written once.
  assert.equal(await thumbs.write(key, Buffer.concat([jpeg, Buffer.alloc(8)])), false);
  assert.deepEqual(await thumbs.read(key), jpeg);
  await thumbs.write(Thumbnails.key(other, run, 2), jpeg);

  // Another start of the application finds them on the disk.
  const again = await new Thumbnails(join(directory, 'thumbnails')).load();
  assert.equal(again.has(key), true);
  assert.equal(again.has(Thumbnails.key(other, run, 2)), true);

  await again.forget(conversation);
  assert.equal(again.has(key), false);
  assert.equal(again.has(Thumbnails.key(other, run, 2)), true);
  await assert.rejects(again.read(key), /introuvable/);
  await again.forget();
  assert.deepEqual(await readdir(join(directory, 'thumbnails')), []);
});

test('only a small JPEG under a well-formed name is kept', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-thumbs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const thumbs = await new Thumbnails(directory).load();
  const key = Thumbnails.key(conversation, run, 0);
  await assert.rejects(thumbs.write(key, Buffer.from('<svg onload=alert(1)>')), /JPEG/);
  await assert.rejects(thumbs.write(key, Buffer.concat([jpeg, Buffer.alloc(500 * 1024)])), /trop lourde/);
  assert.throws(() => Thumbnails.key('../..', run, 0), /invalide/);
  assert.throws(() => Thumbnails.key(conversation, run, '0/../x'), /invalide/);
  // A stray file in the folder is not taken for a thumbnail.
  await writeFile(join(directory, 'notes.jpg'), jpeg);
  assert.equal((await new Thumbnails(directory).load()).known.size, 0);
});

test('the page sends a thumbnail once; the gallery, the cover and the Studio then serve it', async t => {
  const data = await mkdtemp(join(tmpdir(), 'atelier-thumbs-app-'));
  const app = await createApplication({ port: 0, dataDir: data });
  t.after(async () => {
    await app.close();
    await rm(data, { recursive: true, force: true });
  });
  const { token } = await (await fetch(app.url + '/api/bootstrap?brief=1')).json();
  const auth = { Authorization: 'Bearer ' + token };
  const send = (headers, body = jpeg) =>
    fetch(app.url + '/api/gallery/thumbnail', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'image/jpeg', 'X-Conversation-Id': conversation, ...headers },
      body,
    });
  // Not without the token, and not for a creation that does not exist.
  assert.equal((await fetch(app.url + '/api/gallery/thumbnail', { method: 'POST', body: jpeg })).status, 401);
  assert.equal((await send({ 'X-Run-Id': run, 'X-Output-Index': '0' })).status, 404);
  // A conversation with nothing to show has no cover: an empty answer, not an error.
  const cover = await fetch(app.url + '/media/previews/' + conversation + '?key=' + '0'.repeat(64));
  assert.equal(cover.status, 401);
  assert.equal((await readdir(data)).includes('thumbnails'), false, 'nothing was written');
});
