import test from 'node:test';
import assert from 'node:assert/strict';
import { isVideo, splitVideos, videoLine, withVideos } from '../public/chat-videos.mjs';

const fox = { id: '0b5c1a8e-2f3d-4c6b-9a7e-1d2f3a4b5c6d', label: 'Ref 3', name: 'renard « neige ».mp4' };

test('a joined video is one line naming its resource, taken apart again on reload', () => {
  const text = withVideos('Prolonge cette vidéo de 5 s', [fox]);
  assert.match(text, /resource_id 0b5c1a8e-2f3d-4c6b-9a7e-1d2f3a4b5c6d\]$/);
  assert.equal(videoLine(fox).includes('«  neige  »'), false, 'quotes in a file name cannot break the line');
  assert.deepEqual(splitVideos(text), {
    text: 'Prolonge cette vidéo de 5 s',
    videos: [{ label: 'Ref 3', name: 'renard   neige  .mp4', id: fox.id }],
  });
  // A video alone, and a message without any.
  assert.equal(withVideos('', [fox]), videoLine(fox));
  assert.deepEqual(splitVideos('Bonjour'), { text: 'Bonjour', videos: [] });
  assert.equal(withVideos('Bonjour', []), 'Bonjour');
});

test('only MP4 and WebM videos go to the library', () => {
  assert.equal(isVideo({ type: 'video/mp4' }), true);
  assert.equal(isVideo({ type: 'video/webm' }), true);
  assert.equal(isVideo({ type: 'video/quicktime' }), false);
  assert.equal(isVideo({ type: 'image/png' }), false);
});

test('a conversation opened with a video is titled by what the user wrote, else by the video', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { History } = await import('../lib/history.mjs');
  const history = new History(await mkdtemp(join(tmpdir(), 'video-title-')));
  const save = (id, content) => history.save({ id, messages: [{ role: 'user', content }], incomplete: false });
  await save('a1111111-1111-4111-8111-111111111111', withVideos('Prolonge-la', [fox]));
  await save('b2222222-2222-4222-8222-222222222222', withVideos('', [fox]));
  const titles = Object.fromEntries((await history.list()).conversations.map(c => [c.id[0], [c.title, c.firstPrompt]]));
  assert.deepEqual(titles.a, ['Prolonge-la', 'Prolonge-la']);
  assert.equal(titles.b[0], 'Vidéo · renard   neige  .mp4');
});
