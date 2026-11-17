import assert from 'node:assert/strict';
import test from 'node:test';
import { explainFailure } from '../lib/generation-failure.mjs';

// What the engine said when the card had no room left (the user's case of 16/11: a clip of 1152 × 2048
// continued by 5 s on a card of 12 Go), and what the application says of it.
const DRIVER = 'CUDA driver error: device not ready\nThe CUDA driver logged these messages, which may provide useful details:\nFailed to create GPU mapping\n',
  TORCH = 'CUDA out of memory. Tried to allocate 306.00 MiB. GPU 0 has a total capacity of 11.99 GiB of which 907.73 MiB is free.';

test('the card out of memory is said in the user’s words, with what was asked and what to do', () => {
  const clip = { media: 'video', width: 1152, height: 2048, frames: 129, fps: 24, overlap: 9, continues: true };
  for (const said of [DRIVER, TORCH, 'torch.OutOfMemoryError: CUDA out of memory.']) {
    const told = explainFailure(said, clip);
    assert.match(told, /^La carte graphique n’a pas assez de mémoire pour prolonger cette vidéo à sa taille \(1152 × 2048, 5 s\)\./, said.slice(0, 40));
    assert.match(told, /Une suite garde la taille de la vidéo de départ/);
    // Nothing of the words of the libraries.
    assert.doesNotMatch(told, /CUDA|GPU mapping|MiB|driver/);
  }
  // A new video: its whole length, a smaller size or length to choose.
  assert.equal(
    explainFailure(TORCH, { media: 'video', width: 768, height: 448, frames: 121, fps: 24 }),
    'La carte graphique n’a pas assez de mémoire pour cette vidéo (768 × 448, 5 s). Choisissez une taille ou une durée plus petite, ou fermez les programmes qui se servent de la carte.',
  );
  // An image: no length.
  assert.equal(
    explainFailure(DRIVER, { media: 'image', width: 2048, height: 2048 }),
    'La carte graphique n’a pas assez de mémoire pour cette image (2048 × 2048). Choisissez une taille plus petite, ou fermez les programmes qui se servent de la carte.',
  );
  // Nothing known of what was asked: said all the same.
  assert.match(explainFailure(TORCH), /^La carte graphique n’a pas assez de mémoire pour cette image\. Choisissez une taille plus petite/);
  assert.match(explainFailure(TORCH, { media: 'video', frames: 61, fps: 24.5 }), /cette vidéo \(2,5 s\)/);
});

test('a failure that is not known is given back as the engine said it', () => {
  for (const said of ['Le workflow a été modifié avant son exécution.', 'Decoded video dimensions do not match the approved job', 'Audio mux failed: ffmpeg', ''])
    assert.equal(explainFailure(said, { media: 'video', width: 768, height: 448 }), said);
  assert.equal(explainFailure(undefined), '');
  assert.equal(explainFailure('  Fichier absent.  '), 'Fichier absent.');
});
