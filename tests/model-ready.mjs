import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForModel } from '../public/model-ready.mjs';

function engine(states, startError) {
  const calls = [];
  const request = async (route, body, { signal }) => {
    signal.throwIfAborted();
    calls.push(route);
    if (route === 'start' && startError) throw startError;
    return { json: async () => (states.length > 1 ? states.shift() : states[0]) };
  };
  return { request, calls };
}

test('un moteur arrêté démarre une seule fois et attend aussi la vision', async () => {
  const fake = engine([{ state: 'stopped' }, { state: 'loading', vision: false }, { state: 'ready', vision: true }]);
  const states = [];
  const ready = await waitForModel(fake.request, new AbortController().signal, status => states.push(status.state));
  assert.equal(ready.vision, true);
  assert.deepEqual(fake.calls, ['status', 'start', 'status']);
  assert.deepEqual(states, ['loading', 'ready']);
});

test('un moteur prêt ou déjà en chargement ne redémarre pas', async () => {
  for (const states of [[{ state: 'ready' }], [{ state: 'loading' }, { state: 'ready' }]]) {
    const fake = engine(states);
    assert.equal((await waitForModel(fake.request, new AbortController().signal, () => {})).state, 'ready');
    assert.ok(!fake.calls.includes('start'));
  }
});

test('un démarrage concurrent rejoint le chargement existant', async () => {
  const fake = engine(
    [{ state: 'stopped' }, { state: 'loading' }, { state: 'ready' }],
    Object.assign(new Error('Déjà démarré'), { status: 409 }),
  );
  assert.equal((await waitForModel(fake.request, new AbortController().signal, () => {})).state, 'ready');
  assert.equal(fake.calls.filter(route => route === 'start').length, 1);
});

test('annuler pendant le chargement interrompt l’attente sans arrêter le moteur', async () => {
  const fake = engine([{ state: 'loading' }]);
  const controller = new AbortController();
  await assert.rejects(
    waitForModel(fake.request, controller.signal, () => controller.abort()),
    { name: 'AbortError' },
  );
  assert.deepEqual(fake.calls, ['status']);
});

test('les erreurs de démarrage et l’arrêt manuel interrompent l’envoi en attente', async () => {
  const startupError = new Error('Modèle introuvable');
  const fake = engine([{ state: 'error' }], startupError);
  await assert.rejects(
    waitForModel(fake.request, new AbortController().signal, () => {}),
    error => error === startupError,
  );
  for (const status of [
    { state: 'error', error: 'Mémoire insuffisante' },
    { state: 'stopped' },
    { state: 'stopping' },
  ]) {
    const stopped = engine([{ state: 'loading' }, status]);
    await assert.rejects(
      waitForModel(stopped.request, new AbortController().signal, () => {}),
      status.error ? /Mémoire insuffisante/ : /interrompu/,
    );
    assert.ok(!stopped.calls.includes('start'));
  }
});
