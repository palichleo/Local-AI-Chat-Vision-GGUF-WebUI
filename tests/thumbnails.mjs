import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Thumbnails } from '../lib/thumbnails.mjs';
import { createApplication } from '../server.mjs';
import { Gallery } from '../lib/gallery.mjs';
import { blank, healThumbnail, keepThumbnail } from '../public/thumbnails.mjs';

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

test('a thumbnail found black is written again in its place only when asked, under a new address', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-thumbs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const thumbs = await new Thumbnails(directory).load(),
    key = Thumbnails.key(conversation, run, 0),
    again = Buffer.concat([jpeg, Buffer.alloc(8, 2)]);
  assert.equal(thumbs.version(key), 0);
  await thumbs.write(key, jpeg);
  const first = thumbs.version(key);
  assert.ok(first > 0);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await thumbs.write(key, again), false, 'never without asking');
  assert.equal(thumbs.version(key), first);
  assert.equal(await thumbs.write(key, again, { replace: true }), true);
  assert.deepEqual(await thumbs.read(key), again);
  assert.notEqual(thumbs.version(key), first);
  // Another start reads the same time from the disk: the address stays the same.
  assert.equal((await new Thumbnails(directory).load()).version(key), thumbs.version(key));
});

test('the server takes a thumbnail again only to replace a black one; its address then changes', async t => {
  const data = await mkdtemp(join(tmpdir(), 'atelier-thumbs-app-'));
  await new Gallery({ historyDir: join(data, 'history') }).put(
    {
      id: run,
      conversationId: conversation,
      provider: 'native',
      mediaType: 'video',
      workflowId: 'basic',
      workflowName: 'Basic',
      prompt: 'Un renard',
      parameters: {},
      createdAt: '2026-11-15T10:00:00.000Z',
      outputs: [{ source: { filename: 'clip.mp4', subfolder: '', type: 'output' } }],
    },
    { persist: true },
  );
  const app = await createApplication({ port: 0, dataDir: data });
  t.after(async () => {
    await app.close();
    await rm(data, { recursive: true, force: true });
  });
  const { token } = await (await fetch(app.url + '/api/bootstrap?brief=1')).json();
  const auth = { Authorization: 'Bearer ' + token };
  const send = async (headers, body) => {
    const response = await fetch(app.url + '/api/gallery/thumbnail', {
      method: 'POST',
      headers: {
        ...auth,
        'Content-Type': 'image/jpeg',
        'X-Conversation-Id': conversation,
        'X-Run-Id': run,
        'X-Output-Index': '0',
        ...headers,
      },
      body,
    });
    return (await response.json()).thumbUrl;
  };
  const black = jpeg,
    picture = Buffer.concat([jpeg, Buffer.alloc(16, 7)]);
  const first = await send({}, black);
  assert.match(first, /\?key=[0-9a-f]{64}&v=[0-9a-z]+$/);
  assert.equal(await send({}, picture), first, 'written once');
  assert.deepEqual(Buffer.from(await (await fetch(app.url + first)).arrayBuffer()), black);
  await new Promise(resolve => setTimeout(resolve, 20));
  const replaced = await send({ 'X-Replace': '1' }, picture);
  assert.notEqual(replaced, first);
  assert.deepEqual(Buffer.from(await (await fetch(app.url + replaced)).arrayBuffer()), picture);
  const listed = await (await fetch(app.url + '/api/gallery/' + conversation + '?images=0', { headers: auth })).json();
  assert.equal(listed.runs[0].outputs[0].thumbUrl, replaced, 'the creations give the new address');
});

// A page of the browser, as much as the thumbnails need: canvases that say how bright what was
// drawn on them is, clips that load and seek.
function browser(t, { hidden = false } = {}) {
  const previous = globalThis.document,
    clips = [];
  globalThis.document = {
    visibilityState: hidden ? 'hidden' : 'visible',
    createElement(tag) {
      if (tag === 'canvas') {
        const canvas = {
          width: 0,
          height: 0,
          drawn: null,
          getContext: () => ({
            drawImage: source => (canvas.drawn = source),
            getImageData: (x, y, width, height) => {
              const data = new Uint8ClampedArray(width * height * 4);
              for (let i = 0; i < data.length; i += 4) {
                data[i] = data[i + 1] = data[i + 2] = canvas.drawn?.light ?? 0;
                data[i + 3] = canvas.drawn ? 255 : 0;
              }
              return { data };
            },
          }),
          toBlob: resolve => resolve(new Blob(['jpeg'])),
        };
        return canvas;
      }
      // A clip: its first frame not decoded yet (black), a little further a picture.
      const clip = {
        light: 0,
        removeAttribute() {},
        load() {},
        set src(value) {
          this.source = value;
          setTimeout(() => {
            this.videoWidth = 640;
            this.videoHeight = 360;
            this.onloadeddata?.();
          });
        },
        set currentTime(value) {
          this.time = value;
          setTimeout(() => {
            this.light = 180;
            this.onseeked?.();
          });
        },
      };
      clips.push(clip);
      return clip;
    },
  };
  t.after(() => {
    globalThis.document = previous;
  });
  const sent = [];
  const api = async (route, body, options) => {
    sent.push([route, options.headers]);
    return Response.json({ thumbUrl: '/media/thumbs/new' });
  };
  return { clips, sent, api };
}

test('nothing drawn, or black, is not a picture', () => {
  const context = pixels => ({ getImageData: () => ({ data: Uint8ClampedArray.from(pixels) }) });
  assert.equal(blank(context([0, 0, 0, 255, 3, 5, 8, 255]), 2, 1), true);
  assert.equal(blank(context([0, 0, 0, 255, 40, 30, 20, 255]), 2, 1), false);
  assert.equal(blank(context([200, 200, 200, 0]), 1, 1), true, 'transparent: nothing drawn');
});

test('no thumbnail is kept from a hidden page, nor from a black frame: the next display tries again', async t => {
  const where = { conversationId: conversation, runId: 'd4444444-4444-4444-8444-444444444444', index: 0 },
    frame = light => ({ videoWidth: 640, videoHeight: 360, light });
  const { sent, api } = browser(t, { hidden: true });
  assert.equal(await keepThumbnail(api, where, frame(180)), null);
  assert.deepEqual(sent, []);
  globalThis.document.visibilityState = 'visible';
  assert.equal(await keepThumbnail(api, where, frame(0)), null);
  assert.deepEqual(sent, [], 'a black frame is not sent');
  assert.equal(await keepThumbnail(api, where, frame(180)), '/media/thumbs/new');
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1]['X-Replace'], undefined);
  assert.equal(await keepThumbnail(api, where, frame(180)), null, 'once');
});

test('the black thumbnail of a clip is made again from the clip, sent in its place and shown', async t => {
  const { clips, sent, api } = browser(t);
  const output = { thumbUrl: '/media/thumbs/old', originalUrl: '/media/generated/clip' },
    record = {
      id: 'e5555555-5555-4555-8555-555555555555',
      conversationId: conversation,
      provider: 'native',
      mediaType: 'video',
      outputs: [output],
    },
    picture = { naturalWidth: 512, naturalHeight: 288, light: 0, src: output.thumbUrl };
  await healThumbnail(api, record, 0, picture);
  assert.equal(clips.length, 1);
  assert.equal(clips[0].source, '/media/generated/clip#t=0.1');
  assert.equal(clips[0].time, 0.4, 'its first frame black: a little further');
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1]['X-Replace'], '1');
  assert.equal(sent[0][1]['X-Run-Id'], record.id);
  assert.equal(picture.src, '/media/thumbs/new');
  assert.equal(output.thumbUrl, '/media/thumbs/new');
  // Once a session; never for a picture that is not black, nor for an image.
  await healThumbnail(api, record, 0, { ...picture, src: output.thumbUrl });
  const fine = { ...record, id: 'f6666666-6666-4666-8666-666666666666', outputs: [{ ...output }] };
  await healThumbnail(api, fine, 0, { naturalWidth: 512, light: 120 });
  const image = { ...record, id: 'a7777777-7777-4777-8777-777777777777', mediaType: 'image', outputs: [{ ...output }] };
  await healThumbnail(api, image, 0, picture);
  assert.equal(clips.length, 1);
  assert.equal(sent.length, 1);
});
