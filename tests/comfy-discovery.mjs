import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverComfy, testComfyConnection } from '../lib/comfy-discovery.mjs';

function mock(replies, seen = []) {
  return async (url, options) => {
    seen.push(url);
    options.signal.throwIfAborted();
    const base = new URL(url).origin,
      value = replies[base];
    if (!value) throw Error('refused');
    if (value === 'timeout')
      return new Promise((_, reject) =>
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }),
      );
    return Response.json(
      url.endsWith('/queue') ? { queue_running: [], queue_pending: [] } : { devices: [], system: value },
    );
  };
}
test('detects only known local candidates and prefers the saved server', async () => {
  const seen = [],
    fetchImpl = mock(
      { 'http://127.0.0.1:9001': { comfyui_version: '1' }, 'http://127.0.0.1:7821': { comfyui_version: '2' } },
      seen,
    );
  const found = await discoverComfy('http://127.0.0.1:9001', { fetchImpl });
  assert.equal(found.detected, true);
  assert.equal(found.baseUrl, 'http://127.0.0.1:9001');
  assert.ok(seen.length <= 6);
  assert.ok(seen.every(url => /^http:\/\/127\.0\.0\.1:(9001|8188|7821)\//.test(url)));
  assert.equal((await discoverComfy('http://127.0.0.1:8188', { fetchImpl })).baseUrl, 'http://127.0.0.1:7821');
});
test('ignores unrelated HTTP services, keeps manual address on failure, rejects remote addresses', async () => {
  const result = await discoverComfy('http://127.0.0.1:9002', {
    candidates: [],
    fetchImpl: mock({ 'http://127.0.0.1:9002': { name: 'other' } }),
  });
  assert.deepEqual(result, { detected: false, baseUrl: 'http://127.0.0.1:9002' });
  await assert.rejects(testComfyConnection('https://example.com'), /HTTP|localhost/);
});
test('connection testing uses the supplied current address', async () => {
  const result = await testComfyConnection('http://127.0.0.1:9123/', {
    fetchImpl: mock({ 'http://127.0.0.1:9123': { comfyui_version: 'test' } }),
  });
  assert.equal(result.baseUrl, 'http://127.0.0.1:9123');
  assert.equal(result.status.idle, true);
});
