import assert from 'node:assert/strict';
import test from 'node:test';
import { setupUnexpectedErrors, unexpectedMessage } from '../public/unexpected-errors.mjs';

test('an error nobody caught is said once, in plain words; a request given up on purpose is not', () => {
  const listeners = {},
    said = [],
    logged = [];
  let clock = 0,
    leaving = false;
  const view = {
    location: { origin: 'http://127.0.0.1:8787' },
    addEventListener: (type, handler) => (listeners[type] = handler),
  };
  setupUnexpectedErrors({ view, notice: text => said.push(text), quiet: () => leaving, log: error => logged.push(error), now: () => clock });
  const broken = new TypeError('workflowsUI.reset is not a function');
  listeners.error({ error: broken, filename: 'http://127.0.0.1:8787/app.js' });
  assert.deepEqual(said, ['Une action s’est arrêtée sur une erreur inattendue : workflowsUI.reset is not a function']);
  assert.deepEqual(logged, [broken]);
  // The same again at once: said once.
  clock = 5000;
  listeners.error({ error: broken, filename: 'http://127.0.0.1:8787/app.js' });
  assert.equal(said.length, 1);
  clock = 16000;
  listeners.unhandledrejection({ reason: broken });
  assert.equal(said.length, 2);
  // Not ours, or not an error of the user's action.
  listeners.error({ error: new Error('extension'), filename: 'chrome-extension://abc/content.js' });
  listeners.unhandledrejection({ reason: Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }) });
  listeners.error({ message: 'ResizeObserver loop completed with undelivered notifications.' });
  leaving = true;
  listeners.unhandledrejection({ reason: new Error('Failed to fetch') });
  assert.equal(said.length, 2);
  assert.equal(unexpectedMessage(''), '');
  assert.equal(unexpectedMessage('Plain'), 'Une action s’est arrêtée sur une erreur inattendue : Plain');
});
