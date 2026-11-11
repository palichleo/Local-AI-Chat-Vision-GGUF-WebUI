import test from 'node:test';
import assert from 'node:assert/strict';
import { SEEN_NOTE, unseenResources } from '../lib/seen-resources.mjs';

const A = '3c037171-3a50-48bc-9705-9bcbfb223f6a',
  B = 'a34fed7a-57f5-49cc-a0bd-7955eb05d5d2';
const catalog = [
  { id: A, type: 'image', label: 'Ref 1', name: 'swing.png' },
  { id: B, type: 'image', label: 'Ref 2', name: 'stairs.png' },
  { id: 'v', type: 'video', label: 'Ref 3', name: 'clip.mp4' },
];
const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });
const video = call('create_video', { prompt: 'x', start_image: { resource: A }, reference: [{ resource: B }] });

test('images passed to a generator and never looked at are shown to the model first', () => {
  const asked = [{ role: 'user', content: 'une vidéo avec la balançoire puis l’escalier' }];
  assert.deepEqual(
    unseenResources(asked, catalog, video).map(item => item.id),
    [A, B],
  );
  // Shown in this turn: the interface marks the images with their resource.
  const shown = [...asked, { role: 'user', internal: true, resourceId: A, content: [] }];
  assert.deepEqual(
    unseenResources(shown, catalog, video).map(item => item.id),
    [B],
  );
  // Read in an earlier turn: the result of the reading stays, the copies do not.
  const read = [
    ...asked,
    { role: 'tool', content: JSON.stringify({ status: 'loaded', resources: [{ id: A }, { id: B }] }) },
  ];
  assert.deepEqual(unseenResources(read, catalog, video), []);
  const shownFirst = [
    ...asked,
    { role: 'tool', content: JSON.stringify({ status: 'nothing_generated', resources: [{ id: A }, { id: B }] }) },
  ];
  assert.deepEqual(unseenResources(shownFirst, catalog, video), []);
  assert.match(SEEN_NOTE, /Nothing was generated/);
});

test('nothing to show for a call without images, another tool, or no conversation', () => {
  const asked = [{ role: 'user', content: 'une vidéo' }];
  assert.deepEqual(unseenResources(asked, catalog, call('create_video', { prompt: 'x' })), []);
  assert.deepEqual(unseenResources(asked, catalog, call('upscale', { source: { resource: A } })), []);
  assert.deepEqual(unseenResources(undefined, catalog, video), []);
  assert.deepEqual(
    unseenResources(asked, catalog, call('create_image', { prompt: 'x', source: { resource: 'v' } })),
    [],
  );
});
